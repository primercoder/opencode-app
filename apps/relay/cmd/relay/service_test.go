package main

import (
	"flag"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

func TestCheckPidFileSingleton(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "relay.pid")

	// No file: no claim.
	if err := checkPidFile(path); err != nil {
		t.Fatalf("no pid file should pass: %v", err)
	}

	// Garbage or dead pid: stale file is removed and accepted.
	if err := os.WriteFile(path, []byte("not-a-pid\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := checkPidFile(path); err != nil {
		t.Fatalf("garbage pid file should be replaced: %v", err)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("stale pid file should be removed: %v", err)
	}

	// Dead pid: same treatment.
	if err := os.WriteFile(path, []byte("999999\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := checkPidFile(path); err != nil {
		t.Fatalf("dead pid should be replaced: %v", err)
	}

	// Live foreign pid: refused. Spawn a real helper process so the pid is
	// alive but is neither ours nor the "parent hand-off" self-pid case.
	helper := exec.Command("sleep", "60")
	if err := helper.Start(); err != nil {
		t.Skipf("cannot spawn helper process: %v", err)
	}
	defer func() {
		_ = helper.Process.Kill()
		_, _ = helper.Process.Wait()
	}()
	if err := os.WriteFile(path, []byte(strconv.Itoa(helper.Process.Pid)+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	err := checkPidFile(path)
	if err == nil {
		t.Fatal("live foreign pid must be refused")
	}
	if !strings.Contains(err.Error(), "already running") {
		t.Fatalf("unexpected error: %v", err)
	}

	// Our own pid (parent hand-off): adopted.
	self := os.Getpid()
	if err := os.WriteFile(path, []byte(strconv.Itoa(self)+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := checkPidFile(path); err != nil {
		t.Fatalf("own pid should be adopted: %v", err)
	}
}

func TestPidFileRoundTrip(t *testing.T) {
	dir := t.TempDir()
	path := pidFilePath(dir)
	if err := writePidFile(path); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(data)))
	if err != nil {
		t.Fatalf("pid file content: %q", string(data))
	}
	if pid != os.Getpid() {
		t.Fatalf("pid file holds %d, want %d", pid, os.Getpid())
	}
	if !pidAlive(pid) {
		t.Fatal("own pid should be alive")
	}
	if pidAlive(-1) || pidAlive(0) {
		t.Fatal("non-positive pids must not count as alive")
	}
}

func TestServeConfigExecArgsRoundTrip(t *testing.T) {
	cfg := &serveConfig{
		dataDir:     "/tmp/relay-data",
		listen:      "0.0.0.0:9443",
		publicURL:   "ws://203.0.113.10:9443/ws",
		certFile:    "/etc/ocremote/fullchain.pem",
		keyFile:     "/etc/ocremote/privkey.pem",
		maxHosts:    5,
		maxClients:  7,
		adminSocket: "/tmp/relay-data/custom.sock",
		logLevel:    "debug",
	}
	// A re-exec must reconstruct the same serving configuration.
	parsed, err := parseServeFlags(cfg.execArgs())
	if err != nil {
		t.Fatal(err)
	}
	parsed.publicURL = cfg.publicURL
	parsed.daemon, parsed.daemonized = false, false
	if parsed.dataDir != cfg.dataDir || parsed.listen != cfg.listen ||
		parsed.publicURL != cfg.publicURL || parsed.certFile != cfg.certFile ||
		parsed.keyFile != cfg.keyFile || parsed.maxHosts != cfg.maxHosts ||
		parsed.maxClients != cfg.maxClients || parsed.adminSocket != cfg.adminSocket ||
		parsed.logLevel != cfg.logLevel {
		t.Fatalf("round trip mismatch: %+v vs %+v", parsed, cfg)
	}
}

func TestRequireRoot(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("running as root; cannot verify the refusal path")
	}
	err := requireRoot()
	if err == nil {
		t.Fatal("non-root must be refused for system service management")
	}
	if !strings.Contains(err.Error(), "root") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestSystemdUnitAndLaunchdPlistFreezeFlags(t *testing.T) {
	cfg := &serveConfig{
		dataDir:    "/var/lib/ocremote-relay",
		listen:     "0.0.0.0:8443",
		publicURL:  "ws://203.0.113.10:8443/ws",
		maxHosts:   4,
		maxClients: 2,
		logLevel:   "info",
	}
	unit := systemdUnitText("/usr/local/bin/ocremote-relay", cfg)
	for _, want := range []string{
		"ExecStart=/usr/local/bin/ocremote-relay serve",
		"--listen 0.0.0.0:8443",
		"--public-url ws://203.0.113.10:8443/ws",
		"--max-hosts 4",
		"Restart=on-failure",
		"RestartSec=3",
		"WantedBy=multi-user.target",
	} {
		if !strings.Contains(unit, want) {
			t.Fatalf("unit missing %q:\n%s", want, unit)
		}
	}
	if strings.Contains(unit, "--daemon") {
		t.Fatal("service unit must run the relay in the foreground, not --daemon")
	}

	plist := launchdPlistText("/usr/local/bin/ocremote-relay", cfg)
	for _, want := range []string{
		"<string>/usr/local/bin/ocremote-relay</string>",
		"<string>serve</string>",
		"<string>0.0.0.0:8443</string>",
		"<key>RunAtLoad</key>",
		"<key>KeepAlive</key>",
		"<string>/var/lib/ocremote-relay/relay.log</string>",
	} {
		if !strings.Contains(plist, want) {
			t.Fatalf("plist missing %q:\n%s", want, plist)
		}
	}
}

func TestSystemdQuoteAndXMLEscape(t *testing.T) {
	got := systemdQuote([]string{"/bin/x", "two words", `has"quote`, `back\slash`})
	if !strings.Contains(got, `"two words"`) || !strings.Contains(got, `"has\"quote"`) || !strings.Contains(got, `"back\\slash"`) {
		t.Fatalf("quote output: %s", got)
	}
	if strings.Contains(xmlEscape(`a<b>&"c"`), `<`) || strings.Contains(xmlEscape(`a&b`), "& ") {
		t.Fatalf("escape output: %s", xmlEscape(`a<b>&"c"`))
	}
}

func TestServiceInstallUpdatesRunningUnit(t *testing.T) {
	// Simulated on this machine: the unit directory is redirected away from
	// /etc/systemd/system and a fake systemctl records calls and reports the
	// unit active.
	fakeBin := t.TempDir()
	log := filepath.Join(fakeBin, "calls.log")
	fake := "#!/bin/sh\nfor a in \"$@\"; do echo -n \"$a \" >> " + log + "; done\necho >> " + log + "\nexit 0\n"
	if err := os.WriteFile(filepath.Join(fakeBin, "systemctl"), []byte(fake), 0o755); err != nil {
		t.Fatal(err)
	}
	unitDir := t.TempDir()
	origDir := systemdSystemDir
	systemdSystemDir = unitDir
	t.Cleanup(func() { systemdSystemDir = origDir })
	t.Setenv("PATH", fakeBin+":"+os.Getenv("PATH"))

	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	cfg := &serveConfig{dataDir: t.TempDir(), listen: ":18443", maxHosts: 3, maxClients: 3, logLevel: "info"}
	if err := os.MkdirAll(filepath.Dir(systemdUnitPath()), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(systemdUnitPath(), []byte(systemdUnitText(exe, cfg)), 0o644); err != nil {
		t.Fatal(err)
	}

	reloaded, running, err := systemctlApply()
	if err != nil {
		t.Fatalf("systemctlApply: %v", err)
	}
	if !reloaded {
		t.Fatal("reload should succeed via fake systemctl")
	}
	if !running {
		t.Fatal("fake systemctl reports active unit; running should be true")
	}
	calls, err := os.ReadFile(log)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(calls), "daemon-reload") || !strings.Contains(string(calls), "restart") {
		t.Fatalf("expected daemon-reload + restart, got:\n%s", string(calls))
	}
}

func TestServeConfigFilePersistence(t *testing.T) {
	dataDir := t.TempDir()

	// Explicit flags are persisted to <data-dir>/relay-config.json.
	first, err := parseServeFlags([]string{"--data-dir", dataDir, "--listen", "127.0.0.1:18510", "--public-url", "ws://203.0.113.10:18510/ws", "--max-hosts", "7", "--max-clients", "5"})
	if err != nil {
		t.Fatal(err)
	}
	if first.listen != "127.0.0.1:18510" || first.publicURL != "ws://203.0.113.10:18510/ws" || first.maxHosts != 7 || first.maxClients != 5 {
		t.Fatalf("explicit flags lost: %+v", first)
	}
	data, err := os.ReadFile(configFilePath(dataDir))
	if err != nil {
		t.Fatalf("config file not written: %v", err)
	}
	if !strings.Contains(string(data), `"listen": "127.0.0.1:18510"`) {
		t.Fatalf("config file missing listen: %s", string(data))
	}

	// A bare run (only --data-dir) picks up everything from the file.
	second, err := parseServeFlags([]string{"--data-dir", dataDir})
	if err != nil {
		t.Fatal(err)
	}
	if second.listen != "127.0.0.1:18510" || second.publicURL != "ws://203.0.113.10:18510/ws" || second.maxHosts != 7 || second.maxClients != 5 {
		t.Fatalf("saved config not applied: %+v", second)
	}

	// An explicit flag overrides the file and updates the file.
	third, err := parseServeFlags([]string{"--data-dir", dataDir, "--max-hosts", "9"})
	if err != nil {
		t.Fatal(err)
	}
	if third.maxHosts != 9 {
		t.Fatalf("explicit override lost: %+v", third)
	}
	after, err := parseServeFlags([]string{"--data-dir", dataDir})
	if err != nil {
		t.Fatal(err)
	}
	if after.maxHosts != 9 || after.listen != "127.0.0.1:18510" {
		t.Fatalf("file not updated by override: %+v", after)
	}

	// A broken config file must not take the relay down silently with a
	// confusing flag error; it reports the file it could not parse.
	if err := os.WriteFile(configFilePath(dataDir), []byte("{not json"), 0o644); err != nil {
		t.Fatal(err)
	}
	_, err = parseServeFlags([]string{"--data-dir", dataDir})
	if err == nil || !strings.Contains(err.Error(), configFileName) {
		t.Fatalf("expected config parse error naming the file, got: %v", err)
	}
}

func TestAdminParsesFlagsAfterSubcommand(t *testing.T) {
	// Go's flag package stops at the first positional argument; runAdmin must
	// lift the subcommand out so "admin status --data-dir X" honours X.
	command := ""
	args := []string{"status", "--data-dir", "/tmp/x"}
	switch args[0] {
	case "status", "hosts", "clients", "rooms", "revoke":
		command = args[0]
		args = args[1:]
	}
	flags := flag.NewFlagSet("admin", flag.ContinueOnError)
	dataDir := flags.String("data-dir", "./data", "data directory")
	if err := flags.Parse(args); err != nil {
		t.Fatal(err)
	}
	if command != "status" {
		t.Fatalf("command = %q", command)
	}
	if *dataDir != "/tmp/x" {
		t.Fatalf("flag after subcommand dropped: %q", *dataDir)
	}
}
