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
/// reach the command as `CODEG_FOLDER_PATH` / `CODEG_REMOTE_HOST`. It runs in
/// `working_dir` — the folder, when the window is a local one — or, failing
/// that, the home directory: a remote folder's path names nothing here.
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
    let command = validate_local_command(&command)?;
    let shell = crate::terminal::manager::resolve_shell();
    let mut child = tokio::process::Command::new(&shell);
    match shell_invocation(&shell, command) {
        ShellInvocation::Args(args) => {
            child.args(args);
        }
        #[cfg(windows)]
        ShellInvocation::CmdLine(line) => {
            use std::os::windows::process::CommandExt;
            child.as_std_mut().raw_arg(line);
        }
        // Only a Windows host resolves its shell to cmd.exe.
        #[cfg(not(windows))]
        ShellInvocation::CmdLine(_) => {
            return Err(AppCommandError::invalid_input(format!(
                "{shell} can only run commands on Windows"
            )));
        }
    }
    child
        .env("CODEG_CMD", command)
        .env("CODEG_FOLDER_PATH", folder_path.unwrap_or_default())
        .env("CODEG_REMOTE_HOST", remote_host.unwrap_or_default())
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
/// strips only the outer quotes around it.
fn shell_invocation(shell: &str, command: &str) -> ShellInvocation {
    let args: Vec<&str> = match classify_shell_family(shell) {
        ShellFamily::PowerShell => vec![
            "-NoLogo",
            "-NoProfile",
            "-Command",
            "Invoke-Expression $env:CODEG_CMD",
        ],
        ShellFamily::Cmd => return ShellInvocation::CmdLine(format!("/D /S /C \"{command}\"")),
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
            ShellInvocation::CmdLine(r#"/D /S /C "code "%CODEG_FOLDER_PATH%"""#.into())
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
