//! Starts the service: reads the settings, starts logs and telemetry, then serves the routes.

use std::collections::HashMap;
use std::process::ExitCode;

use actix_web::{web, HttpServer};
use service::app::app;
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
    let http = web::Data::new(HttpTelemetry::global());
    let origins = config.cors_origins.clone();
    // Actix Web stops when the platform stops the service, with SIGTERM, or Ctrl+C while
    // developing, and answers the requests already started first.
    let served = actix_web::rt::System::new().block_on(async move {
        let server = HttpServer::new(move || app(&origins, http.clone()))
            .bind((config.host.as_str(), config.port))?
            .run();
        tracing::info!(port = config.port, "Listening");
        server.await
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
