fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();

    // Background server worker spawned by `server start` — runs headless.
    if args.iter().any(|a| a == "--daemon-worker") {
        std::process::exit(llmeter_lib::run_daemon_worker(&args));
    }

    // Any non-daemon argument routes to the CLI so the GUI never opens
    // unexpectedly. Unknown commands print an error; --help/-h print usage;
    // --version/-V print the version. Only a bare launch (no args at all)
    // falls through to the GUI below.
    if !args.is_empty() {
        std::process::exit(llmeter_lib::run_cli(&args));
    }

    llmeter_lib::run();
}
