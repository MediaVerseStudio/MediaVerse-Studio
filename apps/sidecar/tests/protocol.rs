use serde_json::{Value, json};
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};

struct Client {
    child: Child,
    input: ChildStdin,
    output: BufReader<ChildStdout>,
}

impl Client {
    fn start(data_dir: &std::path::Path) -> Self {
        let mut child = Command::new(env!("CARGO_BIN_EXE_mediaverse_sidecar"))
            .arg("--data-dir")
            .arg(data_dir)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .expect("sidecar starts");
        let input = child.stdin.take().unwrap();
        let output = BufReader::new(child.stdout.take().unwrap());
        Self {
            child,
            input,
            output,
        }
    }

    fn read(&mut self) -> Value {
        let mut line = String::new();
        self.output.read_line(&mut line).expect("sidecar line");
        serde_json::from_str(&line).expect("sidecar emits JSON")
    }

    fn write_raw(&mut self, line: &str) {
        writeln!(self.input, "{line}").unwrap();
    }

    fn request(&mut self, id: u64, command: &str, args: Value) -> Value {
        self.write_raw(&json!({ "id": id, "command": command, "args": args }).to_string());
        loop {
            let message = self.read();
            if message["type"] == "response" {
                return message;
            }
        }
    }
}

fn temp_dir(name: &str) -> std::path::PathBuf {
    let dir =
        std::env::temp_dir().join(format!("mediaverse-sidecar-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

#[test]
fn announces_protocol_version_and_commands() {
    let data = temp_dir("ready");
    let mut client = Client::start(&data);
    let ready = client.read();

    assert_eq!(ready["type"], "ready");
    assert_eq!(ready["protocol"], 1);
    assert!(
        ready["commands"]
            .as_array()
            .unwrap()
            .contains(&json!("library_snapshot"))
    );
    let _ = client.child.kill();
}

#[test]
fn answers_commands_and_reports_errors_with_the_request_id() {
    let data = temp_dir("commands");
    let mut client = Client::start(&data);
    client.read();

    let status = client.request(7, "collection_status", Value::Null);
    assert_eq!(status["id"], 7);
    assert_eq!(status["ok"], true);
    assert_eq!(status["result"]["root"], Value::Null);

    let snapshot = client.request(8, "library_snapshot", Value::Null);
    assert_eq!(snapshot["result"]["tracks"], json!([]));

    let unknown = client.request(9, "nope", Value::Null);
    assert_eq!(unknown["ok"], false);
    assert_eq!(unknown["error"]["code"], "unknown_command");

    let missing_root = client.request(10, "rescan_collection", Value::Null);
    assert_eq!(missing_root["error"]["code"], "collection_not_selected");

    let bad_args = client.request(11, "import_collection", json!({}));
    assert_eq!(bad_args["error"]["code"], "invalid_arguments");
    let _ = client.child.kill();
}

#[test]
fn survives_malformed_input_and_shuts_down_on_request() {
    let data = temp_dir("shutdown");
    let mut client = Client::start(&data);
    client.read();

    client.write_raw("this is not json");
    let malformed = client.read();
    assert_eq!(malformed["error"]["code"], "invalid_request");
    assert_eq!(malformed["id"], Value::Null);

    let shutdown = client.request(1, "shutdown", Value::Null);
    assert_eq!(shutdown["ok"], true);
    assert!(client.child.wait().unwrap().success());
}

#[test]
fn imports_an_empty_collection_and_remembers_it_after_restart() {
    let data = temp_dir("persist-data");
    let music = temp_dir("persist-music");
    let mut client = Client::start(&data);
    client.read();
    let imported = client.request(
        1,
        "import_collection",
        json!({ "root": music.to_string_lossy() }),
    );
    assert_eq!(imported["ok"], true, "{imported}");
    assert_eq!(imported["result"]["track_count"], 0);
    client.request(2, "shutdown", Value::Null);
    client.child.wait().unwrap();

    let mut restarted = Client::start(&data);
    restarted.read();
    let status = restarted.request(1, "collection_status", Value::Null);
    assert_eq!(status["result"]["root"], music.to_string_lossy().as_ref());
    let _ = restarted.child.kill();
}
