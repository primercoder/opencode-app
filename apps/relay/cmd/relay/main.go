package main

import (
	"context"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"ocremote/relay/internal/relay"
)

func main() {
	cfg := relay.Config{
		RegistrationSecret: os.Getenv("RELAY_REGISTRATION_SECRET"),
		PublicURL:          os.Getenv("RELAY_PUBLIC_URL"),
		MaxClients:         envInt("RELAY_MAX_CLIENTS", 8),
		MaxFrame:           int64(envInt("RELAY_MAX_FRAME", 1024*1024)),
		QueueSize:          envInt("RELAY_QUEUE_SIZE", 64),
	}
	if value := os.Getenv("RELAY_ROOM_TTL"); value != "" {
		if parsed, err := time.ParseDuration(value); err == nil {
			cfg.RoomTTL = parsed
		}
	}
	if value := os.Getenv("RELAY_PING_INTERVAL"); value != "" {
		if parsed, err := time.ParseDuration(value); err == nil {
			cfg.PingInterval = parsed
		}
	}
	if value := os.Getenv("RELAY_PONG_TIMEOUT"); value != "" {
		if parsed, err := time.ParseDuration(value); err == nil {
			cfg.PongTimeout = parsed
		}
	}

	level := slog.LevelInfo
	if os.Getenv("RELAY_LOG_LEVEL") == "debug" {
		level = slog.LevelDebug
	}
	logger := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: level}))
	slog.SetDefault(logger)

	addr := envString("RELAY_LISTEN", ":8080")
	server := &http.Server{
		Addr:              addr,
		Handler:           relay.New(cfg).Handler(),
		ReadHeaderTimeout: 10 * time.Second,
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	go func() {
		<-ctx.Done()
		shutdown, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = server.Shutdown(shutdown)
	}()

	slog.Info("ocremote relay listening", "addr", addr)
	if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		slog.Error("relay stopped", "error", err)
		os.Exit(1)
	}
}

func envString(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}

func envInt(key string, fallback int) int {
	value := os.Getenv(key)
	if value == "" {
		return fallback
	}
	parsed, err := strconv.Atoi(value)
	if err != nil || parsed <= 0 {
		return fallback
	}
	return parsed
}
