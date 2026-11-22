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
// user-level service management. The relay must behave like the host CLI:
// `--daemon` detaches, `service install` writes a user unit (systemd --user on
// Linux, a LaunchAgent on macOS) that keeps the *foreground* process alive, so
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
	return syscall.Kill(pid, 0) == nil
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
		hint = "\nIt may be running as a service: systemctl --user stop " + serviceUnit
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
	return filepath.Join(configHome(), "systemd", "user", serviceUnit)
}

func launchdPlistPath() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, "Library", "LaunchAgents", launchdLabel+".plist")
}

func configHome() string {
	if xdg := os.Getenv("XDG_CONFIG_HOME"); xdg != "" {
		return xdg
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".config")
}

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
		fmt.Printf("kind       systemd (user)\nunit       %s\ninstalled  %v\n", path, installed)
		if installed {
			fmt.Printf("\nenable:    systemctl --user daemon-reload && systemctl --user enable --now %s\ndisable:   systemctl --user disable --now %s\nstatus:    systemctl --user status %s\nlogs:      journalctl --user -u %s -f\n", serviceUnit, serviceUnit, serviceUnit, serviceUnit)
		}
		return nil
	case serviceLaunchd:
		path := launchdPlistPath()
		_, err := os.Stat(path)
		installed := err == nil
		fmt.Printf("kind       launchd\nplist      %s\ninstalled  %v\n", path, installed)
		if installed {
			fmt.Printf("\nenable:    launchctl load -w %s\ndisable:   launchctl unload -w %s\nstatus:    launchctl list | grep %s\n", path, path, launchdLabel)
		}
		return nil
	default:
		return fmt.Errorf("user services are not supported on %s; run the relay under your own supervisor", currentPlatform())
	}
}

// runServiceInstall writes (or overwrites) the user-level unit from the
// current launch flags, so re-running install with new flags updates the
// service configuration. When the unit is already active it is reloaded and,
// if the service is running, restarted so the change takes effect.
func runServiceInstall(args []string) error {
	cfg, err := parseServeFlags(args)
	if err != nil {
		return err
	}
	if err := cfg.validate(); err != nil {
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
		if applyErr != nil && !reloaded {
			return fmt.Errorf("systemctl --user failed (is a user session running?): %w", applyErr)
		}
		fmt.Printf("service installed: %s\n", path)
		if running {
			fmt.Println("service was running; restarted with the new configuration")
		} else if reloaded {
			fmt.Printf("enable:    systemctl --user enable --now %s\n", serviceUnit)
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
		return fmt.Errorf("user services are not supported on %s; run the relay under your own supervisor", currentPlatform())
	}
}

func runServiceUninstall(args []string) error {
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
		fmt.Printf("if it was enabled, also run: systemctl --user disable --now %s\n", serviceUnit)
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
		return fmt.Errorf("user services are not supported on %s", currentPlatform())
	}
}

// systemctlApply reloads the user manager and reports whether the relay unit
// is currently running; on a running unit it restarts it so a re-install
// updates the live configuration.
func systemctlApply() (reloaded bool, wasRunning bool, err error) {
	rel := exec.Command("systemctl", "--user", "daemon-reload")
	if loadErr := rel.Run(); loadErr != nil {
		return false, false, loadErr
	}
	check := exec.Command("systemctl", "--user", "is-active", "--quiet", serviceUnit)
	running := check.Run() == nil
	if running {
		rst := exec.Command("systemctl", "--user", "restart", serviceUnit)
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
# Noise NK authenticates every peer; no extra hardening is required for the
# relay to run under the installing user's account.
NoNewPrivileges=true

[Install]
WantedBy=default.target
`, systemdQuote(append([]string{exe, "serve"}, cfg.execArgs()...)), cfg.dataDir)
}

func launchdPlistText(exe string, cfg *serveConfig) string {
	args := append([]string{exe, "serve"}, cfg.execArgs()...)
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
