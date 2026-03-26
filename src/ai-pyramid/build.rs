fn main() {
    println!("cargo::rerun-if-changed=ui/dist");
    println!("cargo::rerun-if-changed=static");
}
