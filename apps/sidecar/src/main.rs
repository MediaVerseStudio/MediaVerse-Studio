use mediaverse_sidecar::drives::{Drives, LibraryRoot};
use mediaverse_sidecar::{Output, ready_message, serve};
use std::io::{self, BufReader};
use std::path::PathBuf;
use std::sync::Arc;

fn data_dir_argument() -> Option<PathBuf> {
    let mut args = std::env::args().skip(1);
    while let Some(argument) = args.next() {
        if argument == "--data-dir" {
            return args.next().map(PathBuf::from);
        }
    }
    None
}

fn main() {
    let output = Output::new(io::stdout());
    let Some(data_dir) = data_dir_argument() else {
        eprintln!("usage: mediaverse_sidecar --data-dir <path>");
        std::process::exit(2);
    };

    let host = match mediaverse_host::Host::open(&data_dir, Arc::new(output.clone())) {
        Ok(host) => Arc::new(host),
        Err(error) => {
            eprintln!("MediaVerse sidecar failed to start: {}", error.message);
            std::process::exit(1);
        }
    };

    // The drive code asks the library host where the Main Media Library is.
    let library_host = host.clone();
    let library_root: LibraryRoot = Arc::new(move || {
        library_host
            .dispatch("collection_status", serde_json::Value::Null)
            .ok()
            .and_then(|status| status["root"].as_str().map(PathBuf::from))
    });
    let drives = Drives::new(&data_dir, output.clone(), library_root);
    output.send(&ready_message());
    serve(&host, &drives, &output, BufReader::new(io::stdin().lock()));
}
