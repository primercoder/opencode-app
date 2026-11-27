package main

import (
	"errors"
	"flag"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// Process-lifetime plumbing: pid-file singleton, background daemonization and
// system-level service management. The relay must behave like the host CLI:
// `--daemon` detaches, `service install` writes a system-level unit (systemd
// on Linux, a LaunchDaemon on macOS) that keeps the *foreground* process alive, so
// autostart recovery belongs to the supervisor and is never nested inside a
// daemonized process.

const (
	pidFileName  = "relay.pid"
	logFileName  = "relay.log"
	serviceUnit  = "ocremote-relay.service"
	launchdLabel = "app.ocremote.relay"
)

func pidFilePath(dataDir string) string {
	return filepath.Join(dataDir, pidFileName)
}

func logFilePath(dataDir string) string {
	return filepath.Join(dataDir, logFileName)
}

// pidAlive reports whether the process behind pid is still running.
func pidAlive(pid int) bool {
	if pid <= 0 {
		return false
	}
	// Signal 0 probes for existence without actually signalling. EPERM would
	// mean the process exists but belongs to another user — still "alive".
	err := syscall.Kill(pid, 0)
	return err == nil || errors.Is(err, syscall.EPERM)
}

// checkPidFile enforces the singleton: a live foreign pid is an error, a stale
// file (dead pid or garbage) is replaced. A file holding our own pid (written
// by the parent that spawned this daemonized child) is adopted.
func checkPidFile(path string) error {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil // no file, no claim
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(data)))
	if err != nil || !pidAlive(pid) {
		_ = os.Remove(path)
		return nil
	}
	if pid == os.Getpid() {
		return nil
	}
	return fmt.Errorf("another relay is already running (pid %d, %s)", pid, path)
}

func writePidFile(path string) error {
	return os.WriteFile(path, []byte(strconv.Itoa(os.Getpid())+"\n"), 0o644)
}

// daemonize re-execs the relay detached from the terminal. The child keeps the
// normal foreground flow with stdout/stderr pointed at the log file; the
// supervisor behaviour (crash recovery, autostart) stays with systemd/launchd
// when installed via `service install`, which deliberately does NOT use
// --daemon.
func daemonize(cfg *serveConfig) error {
	exe, err := os.Executable()
	if err != nil {
		return fmt.Errorf("resolve executable: %w", err)
	}
	if err := os.MkdirAll(cfg.dataDir, 0o755); err != nil {
		return fmt.Errorf("create data dir: %w", err)
	}
	logPath := logFilePath(cfg.dataDir)
	logFile, err := os.OpenFile(logPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return fmt.Errorf("open log file: %w", err)
	}
	defer logFile.Close()

	args := append(cfg.execArgs(), "--daemonized")
	cmd := exec.Command(exe, args...)
	cmd.Stdin = nil
	cmd.Stdout = logFile
	cmd.Stderr = logFile
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("start background relay: %w", err)
	}
	pid := cmd.Process.Pid
	// Give the child a moment so an immediate failure (port in use, bad TLS
	// paths) surfaces here instead of silently dying in the background.
	exited := make(chan error, 1)
	go func() { exited <- cmd.Wait() }()
	deadline := time.Now().Add(1200 * time.Millisecond)
	for time.Now().Before(deadline) {
		select {
		case waitErr := <-exited:
			tail := tailLines(logPath, 8)
			return fmt.Errorf("background relay exited immediately: %v\n%s", waitErr, tail)
		case <-time.After(150 * time.Millisecond):
		}
	}
	// The pid file is written by the child itself (see runServe); writing the
	// parent's pid here would overwrite the correct entry and break `stop`.
	fmt.Printf("ocremote-relay started in background (pid %d)\nlog: %s\n", pid, logPath)
	return nil
}

func tailLines(path string, n int) string {
	data, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	lines := strings.Split(strings.TrimRight(string(data), "\n"), "\n")
	if len(lines) > n {
		lines = lines[len(lines)-n:]
	}
	return strings.Join(lines, "\n")
}

func runStop(args []string) error {
	flags := flag.NewFlagSet("ocremote-relay stop", flag.ContinueOnError)
	dataDir := flags.String("data-dir", env("RELAY_DATA_DIR", "./data"), "data directory")
	if err := flags.Parse(args); err != nil {
		return err
	}
	path := pidFilePath(*dataDir)
	data, err := os.ReadFile(path)
	if err != nil {
		return hintNotRunning(*dataDir)
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(data)))
	if err != nil {
		_ = os.Remove(path)
		return hintNotRunning(*dataDir)
	}
	if !pidAlive(pid) {
		_ = os.Remove(path)
		return hintNotRunning(*dataDir)
	}
	if err := syscall.Kill(pid, syscall.SIGTERM); err != nil {
		return fmt.Errorf("signal relay (pid %d): %w", pid, err)
	}
	// Wait for the graceful shutdown to finish before reporting success.
	deadline := time.Now().Add(10 * time.Second)
	for pidAlive(pid) && time.Now().Before(deadline) {
		time.Sleep(120 * time.Millisecond)
	}
	if pidAlive(pid) {
		return fmt.Errorf("relay (pid %d) did not exit within 10s; check %s", pid, logFilePath(*dataDir))
	}
	_ = os.Remove(path)
	fmt.Printf("ocremote-relay stopped (pid %d)\n", pid)
	return nil
}

func hintNotRunning(dataDir string) error {
	hint := ""
	if _, err := os.Stat(systemdUnitPath()); err == nil {
		hint = "\nIt may be running as a service: systemctl stop " + serviceUnit
	}
	return fmt.Errorf("relay is not running (no live pid file in %s)%s", dataDir, hint)
}

// --- service install / status / uninstall -----------------------------------

type serviceKindValue int

const (
	serviceSystemd serviceKindValue = iota
	serviceLaunchd
	serviceUnsupported
)

func currentServiceKind() serviceKindValue {
	switch {
	case isLinux():
		return serviceSystemd
	case isDarwin():
		return serviceLaunchd
	default:
		return serviceUnsupported
	}
}

func systemdUnitPath() string {
	// System-level unit: owned by PID 1 and independent of any login session.
	// A user (session-scoped) unit dies when the installing user logs out
	// unless lingering is enabled, which took the relay down on root-logout
	// servers. Requires root to install.
	// systemdSystemDir is a var so tests can redirect it away from /etc.
	return filepath.Join(systemdSystemDir, serviceUnit)
}

func launchdPlistPath() string {
	// LaunchDaemon (system-wide, runs before any user logs in) instead of a
	// per-user agent, for the same reason as the systemd unit above.
	// launchdDaemonDir is a var so tests can redirect it away from /Library.
	return filepath.Join(launchdDaemonDir, launchdLabel+".plist")
}

var (
	// Real install targets are /etc/systemd/system and /Library/LaunchDaemons;
	// tests override these instead of writing to the host system.
	systemdSystemDir = "/etc/systemd/system"
	launchdDaemonDir = "/Library/LaunchDaemons"
)

func runService(args []string) error {
	if len(args) == 0 {
		return errors.New("missing service command (status|install|uninstall)")
	}
	switch args[0] {
	case "status":
		return runServiceStatus(args[1:])
	case "install":
		return runServiceInstall(args[1:])
	case "uninstall":
		return runServiceUninstall(args[1:])
	default:
		return fmt.Errorf("unknown service command %q (status|install|uninstall)", args[0])
	}
}

func runServiceStatus(args []string) error {
	kind := currentServiceKind()
	switch kind {
	case serviceSystemd:
		path := systemdUnitPath()
		_, err := os.Stat(path)
		installed := err == nil
		fmt.Printf("kind       systemd (system)\nunit       %s\ninstalled  %v\n", path, installed)
		if installed {
			fmt.Printf("\nenable:    systemctl daemon-reload && systemctl enable --now %s\ndisable:   systemctl disable --now %s\nstatus:    systemctl status %s\nlogs:      journalctl -u %s -f\n", serviceUnit, serviceUnit, serviceUnit, serviceUnit)
		}
		return nil
	case serviceLaunchd:
		path := launchdPlistPath()
		_, err := os.Stat(path)
		installed := err == nil
		fmt.Printf("kind       launchd (system daemon)\nplist      %s\ninstalled  %v\n", path, installed)
		if installed {
			fmt.Printf("\nenable:    launchctl load -w %s\ndisable:   launchctl unload -w %s\nstatus:    launchctl list | grep %s\n", path, path, launchdLabel)
		}
		return nil
	default:
		return fmt.Errorf("system services are not supported on %s; run the relay under your own supervisor", currentPlatform())
	}
}

// runServiceInstall stores the serving options in the data directory and
// reloads systemd. An active unit restarts with the new configuration.
func runServiceInstall(args []string) error {
	cfg, err := parseServeFlags(args)
	if err != nil {
		return err
	}
	if err := cfg.validate(); err != nil {
		return err
	}
	// System-level units live outside any user session and are written under
	// /etc or /Library, so installing needs root from the start.
	if err := requireRoot(); err != nil {
		return err
	}
	exe, err := os.Executable()
	if err != nil {
		return fmt.Errorf("resolve executable: %w", err)
	}
	if exe, err = filepath.EvalSymlinks(exe); err != nil {
		return fmt.Errorf("resolve executable: %w", err)
	}
	absData, err := filepath.Abs(cfg.dataDir)
	if err != nil {
		return fmt.Errorf("resolve data dir: %w", err)
	}
	unitCfg := *cfg
	unitCfg.dataDir = absData
	for _, path := range []*string{&unitCfg.certFile, &unitCfg.keyFile, &unitCfg.adminSocket} {
		if *path == "" {
			continue
		}
		*path, err = filepath.Abs(*path)
		if err != nil {
			return fmt.Errorf("resolve service path: %w", err)
		}
	}
	if err := unitCfg.saveFileConfig(); err != nil {
		return fmt.Errorf("save service config: %w", err)
	}

	kind := currentServiceKind()
	var path string
	switch kind {
	case serviceSystemd:
		path = systemdUnitPath()
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			return err
		}
		if err := os.WriteFile(path, []byte(systemdUnitText(exe, &unitCfg)), 0o644); err != nil {
			return err
		}
		// Apply the new configuration: reload units; restart when running.
		reloaded, running, applyErr := systemctlApply()
		if applyErr != nil {
			return fmt.Errorf("systemctl failed: %w", applyErr)
		}
		fmt.Printf("service installed: %s\n", path)
		if running {
			fmt.Println("service was running; restarted with the new configuration")
		} else if reloaded {
			fmt.Printf("enable:    systemctl enable --now %s\n", serviceUnit)
		}
		return nil
	case serviceLaunchd:
		path = launchdPlistPath()
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			return err
		}
		if err := os.WriteFile(path, []byte(launchdPlistText(exe, &unitCfg)), 0o644); err != nil {
			return err
		}
		fmt.Printf("service installed: %s\n", path)
		fmt.Printf("enable:    launchctl load -w %s\n", path)
		return nil
	default:
		return fmt.Errorf("system services are not supported on %s; run the relay under your own supervisor", currentPlatform())
	}
}

func runServiceUninstall(args []string) error {
	if err := requireRoot(); err != nil {
		return err
	}
	kind := currentServiceKind()
	switch kind {
	case serviceSystemd:
		path := systemdUnitPath()
		_, statErr := os.Stat(path)
		_ = os.Remove(path)
		if statErr != nil {
			return fmt.Errorf("service is not installed (%s)", path)
		}
		_, _, _ = systemctlApply() // best-effort reload after removal
		fmt.Printf("service removed: %s\n", path)
		fmt.Printf("if it was enabled, also run: systemctl disable --now %s\n", serviceUnit)
		return nil
	case serviceLaunchd:
		path := launchdPlistPath()
		_, statErr := os.Stat(path)
		_ = os.Remove(path)
		if statErr != nil {
			return fmt.Errorf("service is not installed (%s)", path)
		}
		fmt.Printf("service removed: %s\n", path)
		fmt.Printf("if it was loaded, also run: launchctl unload -w %s\n", path)
		return nil
	default:
		return fmt.Errorf("system services are not supported on %s", currentPlatform())
	}
}

// requireRoot gates the commands that write system-level service definitions.
// /etc/systemd/system and /Library/LaunchDaemons are outside any user session,
// so a non-root attempt would fail halfway through.
func requireRoot() error {
	if os.Geteuid() == 0 {
		return nil
	}
	return fmt.Errorf("system service management requires root: rerun with sudo")
}

// systemctlApply reloads the system manager and reports whether the relay unit
// is currently running; on a running unit it restarts it so a re-install
// updates the live configuration.
func systemctlApply() (reloaded bool, wasRunning bool, err error) {
	rel := exec.Command("systemctl", "daemon-reload")
	if loadErr := rel.Run(); loadErr != nil {
		return false, false, loadErr
	}
	check := exec.Command("systemctl", "is-active", "--quiet", serviceUnit)
	running := check.Run() == nil
	if running {
		rst := exec.Command("systemctl", "restart", serviceUnit)
		if rstErr := rst.Run(); rstErr != nil {
			return true, true, rstErr
		}
	}
	return true, running, nil
}

func systemdUnitText(exe string, cfg *serveConfig) string {
	return fmt.Sprintf(`[Unit]
Description=OC Remote relay (encrypted relay for OC Remote)
Documentation=https://primercoder.github.io/opencode-app/
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=%s
WorkingDirectory=%s
Restart=on-failure
RestartSec=3
# System-level hardening. The data dir is intentionally NOT locked down
# (ProtectHome/ProtectSystem=strict would break data dirs under /home or
# /root, which is the common root-server layout): the relay only needs its
# own data dir plus network, and holds no privileges after start.
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
`, systemdQuote([]string{exe, "serve", "--data-dir", cfg.dataDir}), strings.ReplaceAll(cfg.dataDir, "%", "%%"))
}

func launchdPlistText(exe string, cfg *serveConfig) string {
	args := []string{exe, "serve", "--data-dir", cfg.dataDir}
	var b strings.Builder
	b.WriteString(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>` + launchdLabel + `</string>
	<key>ProgramArguments</key>
	<array>
`)
	for _, arg := range args {
		b.WriteString("\t\t<string>" + xmlEscape(arg) + "</string>\n")
	}
	b.WriteString(`	</array>
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<true/>
	<key>StandardOutPath</key>
	<string>` + xmlEscape(logFilePath(cfg.dataDir)) + `</string>
	<key>StandardErrorPath</key>
	<string>` + xmlEscape(logFilePath(cfg.dataDir)) + `</string>
</dict>
</plist>
`)
	return b.String()
}

func systemdQuote(args []string) string {
	quoted := make([]string, 0, len(args))
	for _, arg := range args {
		arg = strings.NewReplacer("%", "%%", "$", "$$").Replace(arg)
		if strings.ContainsAny(arg, " \t\"'\\") {
			quoted = append(quoted, `"`+strings.NewReplacer(`\`, `\\`, `"`, `\"`).Replace(arg)+`"`)
			continue
		}
		quoted = append(quoted, arg)
	}
	return strings.Join(quoted, " ")
}

func xmlEscape(s string) string {
	r := strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;", `"`, "&quot;")
	return r.Replace(s)
}

func isLinux() bool  { return runtime.GOOS == "linux" }
func isDarwin() bool { return runtime.GOOS == "darwin" }

func currentPlatform() string { return runtime.GOOS }
