// Rebuild when the project's AcoustID application key (supplied at build time, see BUILT_IN_ACOUSTID_KEY) is added, changed or removed.
fn main() {
    println!("cargo:rerun-if-env-changed=MEDIAVERSE_ACOUSTID_KEY");
}
