use std::ffi::OsString;
use std::path::PathBuf;
use std::process::Stdio;

use crate::app_error::AppCommandError;
use crate::terminal::shell_flavor::{classify_shell_family, ShellFamily};

/// Run a folder command on the machine this desktop app runs on, even when the
/// window is bound to a remote codeg-server.
///
/// Every other folder-command path goes through the window's transport, which
/// in a remote-desktop window means the remote host. This one is only ever
/// called through the local shell transport, and is not routed in the web
/// server, so the command can only ever land on the user's own machine.
///
/// The command runs detached through the user's shell with nothing attached to
/// stdio — it is meant for launchers (`zed ssh://…`, `open …`), not for jobs
/// whose output matters. A successful return only means the shell was spawned.
///
/// `folder_path` is the active folder's path *on its host* (the remote path in a
/// remote-desktop window) and `remote_host` the remote server's host name; both
/// reach the command as `CODEG_FOLDER_PATH` / `CODEG_REMOTE_HOST`. `remote_host`
/// is present exactly when the window is bound to a remote server (empty when
/// its name can't be read), and so exactly when `folder_path` came from that
/// server rather than from this machine. The command runs in `working_dir` —
/// the folder, when the window is a local one — or, failing that, the home
/// directory: a remote folder's path names nothing here.
///
/// `async` because the spawn needs a tokio runtime in scope, not because it
/// awaits anything.
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn run_local_command(
    command: String,
    folder_path: Option<String>,
    remote_host: Option<String>,
    working_dir: Option<String>,
) -> Result<(), AppCommandError> {
    let shell = crate::terminal::manager::resolve_shell();
    spawn_local_command(&shell, &command, folder_path, remote_host, working_dir)
}

/// [`run_local_command`] in `shell`.
fn spawn_local_command(
    shell: &str,
    command: &str,
    folder_path: Option<String>,
    remote_host: Option<String>,
    working_dir: Option<String>,
) -> Result<(), AppCommandError> {
    let command = validate_local_command(command)?;
    let remote = remote_host.is_some();
    let folder_path = folder_path.unwrap_or_default();
    let remote_host = remote_host.unwrap_or_default();
    let mut child = tokio::process::Command::new(shell);
    match shell_invocation(shell, command) {
        ShellInvocation::Args(args) => {
            child.args(args);
        }
        ShellInvocation::CmdLine(line) => {
            if remote {
                for (name, value) in [
                    ("CODEG_FOLDER_PATH", &folder_path),
                    ("CODEG_REMOTE_HOST", &remote_host),
                ] {
                    reject_unquoted_cmd_variable(command, name)?;
                    reject_cmd_syntax(name, value)?;
                }
            }
            append_cmd_line(&mut child, line)?;
        }
    }
    child
        .env("CODEG_CMD", command)
        .env("CODEG_FOLDER_PATH", folder_path)
        .env("CODEG_REMOTE_HOST", remote_host)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    if let Some(dir) = resolve_working_dir(working_dir.as_deref()) {
        child.current_dir(dir);
    }
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        child.creation_flags(CREATE_NO_WINDOW);
    }

    // Dropping tokio's `Child` hands it to the runtime's orphan queue, which
    // reaps it once it exits (see `open_in::spawn_vscode`).
    child.spawn().map(|_| ()).map_err(|err| {
        AppCommandError::external_command("Failed to run local command", format!("{shell}: {err}"))
    })
}

/// Hand cmd.exe its command line as it is. Passed as an argument, std would
/// quote it the MSVC way, which cmd does not undo.
#[cfg(windows)]
fn append_cmd_line(
    child: &mut tokio::process::Command,
    line: String,
) -> Result<(), AppCommandError> {
    use std::os::windows::process::CommandExt;
    child.as_std_mut().raw_arg(line);
    Ok(())
}

/// Only a Windows host resolves its shell to cmd.exe.
#[cfg(not(windows))]
fn append_cmd_line(
    _child: &mut tokio::process::Command,
    line: String,
) -> Result<(), AppCommandError> {
    Err(AppCommandError::invalid_input(format!(
        "cmd.exe runs only on Windows: {line}"
    )))
}

/// Refuse `value`, the variable `name`, when it holds a character cmd.exe reads
/// as syntax. cmd splices a `%VAR%` value into its command line before it
/// parses that line, so such a value can close a quoted argument or chain a
/// command of its own: a remote folder named `/srv/x" & calc.exe & rem "` turns
/// `echo "%CODEG_FOLDER_PATH%"` into a launch of calc.exe. Only a remote
/// window's values are checked: they come from the remote server, which is not
/// trusted with this machine, while a local window's are this machine's own.
fn reject_cmd_syntax(name: &str, value: &str) -> Result<(), AppCommandError> {
    let syntax = value
        .chars()
        .find(|c| c.is_control() || matches!(c, '"' | '&' | '|' | '<' | '>' | '^' | '%' | '!'));
    match syntax {
        Some(c) => Err(AppCommandError::invalid_input(format!(
            "{name} from the remote server holds {c:?}, which cmd.exe would read as part of the command"
        ))),
        None => Ok(()),
    }
}

/// Refuse `command` when it names the variable `name` outside double quotes.
/// There cmd parses the value it splices in like the rest of the line, so the
/// value's spaces and parentheses can put a command where cmd expects one: a
/// remote folder named `C:\Windows calc.exe` makes
/// `if exist %CODEG_FOLDER_PATH% code .` launch calc.exe. Inside quotes the
/// value stays one argument, and `reject_cmd_syntax` keeps it from closing
/// them. Like that check, this one is for a remote window's commands only.
fn reject_unquoted_cmd_variable(command: &str, name: &str) -> Result<(), AppCommandError> {
    if cmd_names_unquoted(command, name) {
        return Err(AppCommandError::invalid_input(format!(
            "%{name}% is outside double quotes, where cmd.exe would read the remote server's value as part of the command"
        )));
    }
    Ok(())
}

/// Whether `command` names the variable `name` — `%NAME%`, or `%NAME:…%` for a
/// substring or substitution, in any case — outside double quotes as cmd.exe
/// reads them: each `"` opens or closes them, but outside them `^` escapes the
/// character after it, a `"` included. A reference counts wherever it stands,
/// a caret before it included: cmd expands `%…%` before it reads carets.
fn cmd_names_unquoted(command: &str, name: &str) -> bool {
    let mut quoted = false;
    let mut escaped = false;
    for (i, c) in command.char_indices() {
        if c == '%' && !quoted && names_variable(&command[i + 1..], name) {
            return true;
        }
        if escaped {
            escaped = false;
        } else if c == '"' {
            quoted = !quoted;
        } else if c == '^' && !quoted {
            escaped = true;
        }
    }
    false
}

/// Whether `rest`, the text after a `%`, starts with the variable `name`.
fn names_variable(rest: &str, name: &str) -> bool {
    rest.get(..name.len())
        .is_some_and(|head| head.eq_ignore_ascii_case(name))
        && rest[name.len()..].starts_with(['%', ':'])
}

/// `requested` when it is a directory on this machine, else the home directory.
/// Never trimmed: a path is used exactly as given.
fn resolve_working_dir(requested: Option<&str>) -> Option<PathBuf> {
    requested
        .map(PathBuf::from)
        .filter(|dir| dir.is_dir())
        .or_else(dirs::home_dir)
}

fn validate_local_command(command: &str) -> Result<&str, AppCommandError> {
    let trimmed = command.trim();
    if trimmed.is_empty() {
        return Err(AppCommandError::invalid_input("command is required"));
    }
    if trimmed.contains('\0') {
        return Err(AppCommandError::invalid_input(
            "command must not contain NUL characters",
        ));
    }
    Ok(trimmed)
}

/// How a command is handed to the shell that runs it.
#[derive(Debug, PartialEq, Eq)]
enum ShellInvocation {
    /// Arguments, quoted for the program the usual way.
    Args(Vec<OsString>),
    /// cmd.exe's whole command line, appended verbatim (Windows only).
    CmdLine(String),
}

/// Run `command` and exit. Where the shell can evaluate a variable, the
/// command travels in `$CODEG_CMD` rather than argv to sidestep quoting — the
/// same indirection the built-in terminal uses. POSIX shells get `-l` so the
/// user's login profile (PATH for `zed`, `code`, …) applies; no `-i`, as there
/// is no TTY here.
///
/// cmd.exe is the exception: it expands `%VAR%` once, over its own command
/// line, and never inside a value it expanded, so behind `%CODEG_CMD%` the
/// `%CODEG_FOLDER_PATH%` in a command would reach the program literally. The
/// command is the command line itself instead, as if typed at a prompt; `/S`
/// strips only the outer quotes around it, and `/V:OFF` keeps a `!` literal
/// even where the registry turns delayed expansion on. Splicing values into the
/// line is what `reject_unquoted_cmd_variable` and `reject_cmd_syntax` guard.
fn shell_invocation(shell: &str, command: &str) -> ShellInvocation {
    let args: Vec<&str> = match classify_shell_family(shell) {
        ShellFamily::PowerShell => vec![
            "-NoLogo",
            "-NoProfile",
            "-Command",
            "Invoke-Expression $env:CODEG_CMD",
        ],
        ShellFamily::Cmd => {
            return ShellInvocation::CmdLine(format!("/D /V:OFF /S /C \"{command}\""))
        }
        ShellFamily::Posix if is_bash_like(shell) => vec!["-l", "-c", "eval \"$CODEG_CMD\""],
        // nu / xonsh / elvish: no assumptions about `-l` or `eval`.
        ShellFamily::Posix => vec!["-c", command],
    };
    ShellInvocation::Args(args.into_iter().map(OsString::from).collect())
}

fn is_bash_like(shell: &str) -> bool {
    matches!(
        crate::terminal::shell_flavor::shell_basename(shell).trim_end_matches(".exe"),
        "bash" | "zsh" | "sh" | "dash" | "ksh" | "ash" | "mksh" | "busybox" | "fish"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validate_rejects_blank_command() {
        let err = validate_local_command("   ").expect_err("blank");
        assert!(err.message.contains("required"), "{err:?}");
    }

    #[test]
    fn validate_trims_command() {
        assert_eq!(validate_local_command("  zed .  ").unwrap(), "zed .");
    }

    fn args(items: &[&str]) -> ShellInvocation {
        ShellInvocation::Args(items.iter().map(OsString::from).collect())
    }

    #[test]
    fn bash_like_shells_eval_the_env_var_in_a_login_shell() {
        assert_eq!(
            shell_invocation("/bin/zsh", "zed ."),
            args(&["-l", "-c", "eval \"$CODEG_CMD\""])
        );
    }

    #[test]
    fn cmd_runs_the_command_as_its_own_command_line() {
        // So cmd's one expansion pass reaches the variables in the command.
        assert_eq!(
            shell_invocation("cmd.exe", r#"code "%CODEG_FOLDER_PATH%""#),
            ShellInvocation::CmdLine(r#"/D /V:OFF /S /C "code "%CODEG_FOLDER_PATH%"""#.into())
        );
    }

    #[test]
    fn runs_in_the_requested_directory_when_it_exists() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().to_str().expect("utf-8 temp path");
        assert_eq!(resolve_working_dir(Some(path)), Some(dir.path().into()));
    }

    #[test]
    fn falls_back_to_home_for_a_path_that_names_nothing_here() {
        let dir = tempfile::tempdir().expect("tempdir");
        let missing = dir.path().join("not-here");
        let missing = missing.to_str().expect("utf-8 temp path");
        assert_eq!(resolve_working_dir(Some(missing)), dirs::home_dir());
        assert_eq!(resolve_working_dir(Some("")), dirs::home_dir());
        assert_eq!(resolve_working_dir(None), dirs::home_dir());
    }

    #[test]
    fn cmd_refuses_a_remote_folder_path_it_would_read_as_syntax() {
        // Refused before anything is spawned, on every platform.
        let err = spawn_local_command(
            "cmd.exe",
            r#"echo "%CODEG_FOLDER_PATH%""#,
            Some(r#"/srv/repo" & calc.exe & rem ""#.into()),
            Some("devbox".into()),
            None,
        )
        .expect_err("refused");
        // Off Windows, cmd.exe not running would be an error naming the
        // variable too, through the command line it quotes.
        assert!(
            err.message
                .contains(r#"CODEG_FOLDER_PATH from the remote server holds '"'"#),
            "{err:?}"
        );
    }

    #[test]
    fn cmd_refuses_a_remote_variable_outside_double_quotes() {
        for (command, folder, refused) in [
            // Spaces alone put `calc.exe` where `if` expects its command.
            (
                "if exist %CODEG_FOLDER_PATH% code .",
                r"C:\Windows calc.exe",
                "%CODEG_FOLDER_PATH%",
            ),
            (
                "for %i in (%CODEG_FOLDER_PATH%) do echo %i",
                "/srv/repo) do calc.exe #",
                "%CODEG_FOLDER_PATH%",
            ),
            (
                r#"zed ssh://%CODEG_REMOTE_HOST%"%CODEG_FOLDER_PATH%""#,
                "/srv/repo",
                "%CODEG_REMOTE_HOST%",
            ),
        ] {
            let err = spawn_local_command(
                "cmd.exe",
                command,
                Some(folder.into()),
                Some("devbox".into()),
                None,
            )
            .expect_err(command);
            assert!(
                err.message
                    .contains(&format!("{refused} is outside double quotes")),
                "{command}: {err:?}"
            );
        }
    }

    #[test]
    fn cmd_reads_quotes_and_carets_as_cmd_does() {
        for command in [
            "code %CODEG_FOLDER_PATH%",
            "code %codeg_folder_path%",
            "code %CODEG_FOLDER_PATH:~1%",
            r#"code "a" %CODEG_FOLDER_PATH% "b""#,
            // A caret doesn't keep cmd from expanding the reference after it.
            "code ^%CODEG_FOLDER_PATH%",
            // Escaped quotes open nothing.
            r#"code ^"%CODEG_FOLDER_PATH%^""#,
            // Inside quotes a caret is literal, so the quote after it closes.
            r#"code "^"%CODEG_FOLDER_PATH%""#,
        ] {
            assert!(
                cmd_names_unquoted(command, "CODEG_FOLDER_PATH"),
                "{command}"
            );
        }
        for command in [
            r#"code "%CODEG_FOLDER_PATH%""#,
            r#"zed "ssh://me@%CODEG_REMOTE_HOST%%CODEG_FOLDER_PATH%""#,
            // A literal quote, then a quoted reference.
            r#"code "x"^""%CODEG_FOLDER_PATH%""#,
            // Other variables, delayed expansion (off) and bare text.
            "echo %CODEG_FOLDER_PATHS% %OTHER% !CODEG_FOLDER_PATH! CODEG_FOLDER_PATH",
        ] {
            assert!(
                !cmd_names_unquoted(command, "CODEG_FOLDER_PATH"),
                "{command}"
            );
        }
    }

    #[test]
    fn cmd_syntax_is_refused_and_ordinary_paths_pass() {
        for path in ["/home/me/My Projects/repo-1.0_x", "/srv/仓库/@scope+x=1,y~"] {
            assert!(
                reject_cmd_syntax("CODEG_FOLDER_PATH", path).is_ok(),
                "{path}"
            );
        }
        for path in [
            "/a\"b", "/a&b", "/a|b", "/a<b", "/a>b", "/a^b", "/a%PATH%", "/a!b", "/a\nb",
        ] {
            assert!(
                reject_cmd_syntax("CODEG_FOLDER_PATH", path).is_err(),
                "{path}"
            );
        }
    }

    #[cfg(not(windows))]
    #[test]
    fn cmd_takes_a_local_windows_folder_path_as_it_is() {
        // `C:\R&D` is a folder of this machine: no refusal, so the only error
        // left off Windows is that cmd.exe does not run here.
        let err = spawn_local_command(
            "cmd.exe",
            "echo %CODEG_FOLDER_PATH%",
            Some(r"C:\R&D".into()),
            None,
            None,
        )
        .expect_err("cmd.exe off Windows");
        assert!(err.message.contains("only on Windows"), "{err:?}");
    }

    #[test]
    fn unknown_posix_shells_get_the_command_verbatim() {
        assert_eq!(
            shell_invocation("/usr/bin/nu", "zed ."),
            args(&["-c", "zed ."])
        );
    }

    #[cfg(not(windows))]
    #[tokio::test]
    async fn runs_command_with_folder_env_in_the_working_dir() {
        use std::time::{Duration, Instant};

        let dir = tempfile::tempdir().expect("tempdir");
        let marker = dir.path().join("marker.txt");
        run_local_command(
            format!(
                "printf '%s|%s|%s' \"$CODEG_FOLDER_PATH\" \"$CODEG_REMOTE_HOST\" \"$(pwd -P)\" > '{}'",
                marker.display()
            ),
            Some("/srv/repo".into()),
            Some("devbox".into()),
            Some(dir.path().to_str().expect("utf-8 temp path").into()),
        )
        .await
        .expect("spawn");
        // `pwd -P` resolves symlinks (macOS's /var is one).
        let expected = format!(
            "/srv/repo|devbox|{}",
            std::fs::canonicalize(dir.path())
                .expect("canonical temp dir")
                .display()
        );

        // Generous: the wait ends as soon as the marker appears, and a login
        // shell's profile (nvm, conda, …) on a busy machine can take seconds.
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            if let Ok(contents) = std::fs::read_to_string(&marker) {
                if !contents.is_empty() {
                    assert_eq!(contents, expected);
                    return;
                }
            }
            assert!(Instant::now() < deadline, "command never wrote the marker");
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }
}
