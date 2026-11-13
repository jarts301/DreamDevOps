//! Starts the service: reads the settings, starts logs and telemetry, then serves the routes.

use std::collections::HashMap;
use std::process::ExitCode;
use std::sync::Arc;

use service::app::router;
use service::config::load_config;
use service::logs;
use service::telemetry::{start_telemetry, HttpTelemetry};

fn main() -> ExitCode {
    logs::init();
    let env: HashMap<String, String> = std::env::vars_os()
        .filter_map(|(name, value)| Some((name.into_string().ok()?, value.into_string().ok()?)))
        .collect();
    let config = match load_config(&env) {
        Ok(config) => config,
        Err(problem) => {
            tracing::error!("{problem}");
            return ExitCode::FAILURE;
        }
    };
    // Before the async runtime, as it sends from threads of its own.
    let telemetry = match start_telemetry(&env) {
        Ok(telemetry) => telemetry,
        Err(problem) => {
            tracing::error!("Telemetry can't start: {problem}");
            return ExitCode::FAILURE;
        }
    };
    let served = tokio::runtime::Runtime::new().and_then(|runtime| {
        runtime.block_on(async {
            let app = router(&config.cors_origins, Arc::new(HttpTelemetry::global()));
            let listener = tokio::net::TcpListener::bind((config.host.as_str(), config.port)).await?;
            tracing::info!(port = config.port, "Listening");
            axum::serve(listener, app).with_graceful_shutdown(stopped()).await
        })
    });
    telemetry.shutdown();
    match served {
        Ok(()) => ExitCode::SUCCESS,
        Err(problem) => {
            tracing::error!("The service stopped: {problem}");
            ExitCode::FAILURE
        }
    }
}

/// When the platform stops the service, with SIGTERM, or Ctrl+C while developing. Requests
/// already started are answered first.
async fn stopped() {
    let interrupted = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let terminated = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut signal) => {
                signal.recv().await;
            }
            Err(_) => std::future::pending().await,
        }
    };
    #[cfg(not(unix))]
    let terminated = std::future::pending::<()>();
    tokio::select! {
        () = interrupted => {}
        () = terminated => {}
    }
}
