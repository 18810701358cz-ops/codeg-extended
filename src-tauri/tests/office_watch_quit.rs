//! Quitting while an office preview's `officecli watch` is still starting.
//!
//! officecli renders the whole document before it announces readiness, so a
//! start can take tens of seconds. The quit path must take such a child down
//! too: the process ends without dropping the pending start, and an officecli
//! left behind would finish starting and refuse every later watch of its file.
//!
//! A test binary of its own because it points `PATH` at a fake officecli,
//! which no other test in the process may see.

#![cfg(unix)]

use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::time::Duration;

use codeg_lib::office_watch::{start_office_watch_core, stop_all_office_watches};

/// An `officecli` that records its pid and then never announces readiness.
const FAKE_OFFICECLI: &str = "#!/bin/sh\necho $$ > \"$0.pid\"\nexec sleep 600\n";

async fn wait_for_pid(pid_file: &Path) -> i32 {
    for _ in 0..200 {
        if let Ok(text) = std::fs::read_to_string(pid_file) {
            if let Ok(pid) = text.trim().parse() {
                return pid;
            }
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("the fake officecli never started");
}

fn is_running(pid: i32) -> bool {
    // A killed child lingers as a zombie until it is waited for, which counts
    // as gone here.
    let status = std::process::Command::new("ps")
        .args(["-o", "stat=", "-p", &pid.to_string()])
        .output()
        .expect("run ps");
    let stat = String::from_utf8_lossy(&status.stdout);
    let stat = stat.trim();
    !stat.is_empty() && !stat.starts_with('Z')
}

#[tokio::test]
async fn quitting_kills_a_watch_that_is_still_starting() {
    let bin = tempfile::tempdir().unwrap();
    let fake = bin.path().join("officecli");
    std::fs::write(&fake, FAKE_OFFICECLI).unwrap();
    std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).unwrap();
    let docs = tempfile::tempdir().unwrap();
    std::fs::write(docs.path().join("report.docx"), b"x").unwrap();
    let root = docs.path().to_string_lossy().to_string();
    let path = format!("{}:/usr/bin:/bin", bin.path().display());

    temp_env::async_with_vars([("PATH", Some(path))], async {
        let start = tokio::spawn(start_office_watch_core(root, "report.docx".into()));
        let pid = wait_for_pid(&bin.path().join("officecli.pid")).await;
        assert!(is_running(pid));

        stop_all_office_watches();

        let result = tokio::time::timeout(Duration::from_secs(10), start)
            .await
            .expect("the start should answer once its child is killed")
            .unwrap();
        assert!(result.is_err(), "{result:?}");
        let mut gone = false;
        for _ in 0..100 {
            if !is_running(pid) {
                gone = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        assert!(
            gone,
            "quitting left the starting officecli (pid {pid}) running"
        );

        // A start that gets its child going after the quit kills it at once.
        let late = tokio::time::timeout(
            Duration::from_secs(10),
            start_office_watch_core(
                docs.path().to_string_lossy().to_string(),
                "report.docx".into(),
            ),
        )
        .await
        .expect("a start after quitting should answer at once");
        assert!(
            matches!(&late, Err(err) if err.to_string().contains("quitting")),
            "{late:?}"
        );
    })
    .await;
}
