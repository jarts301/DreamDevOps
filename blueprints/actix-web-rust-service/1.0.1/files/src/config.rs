//! Reads the service's settings from environment variables, so one image runs in every environment.

use std::collections::HashMap;

/// The service's settings.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Config {
    pub host: String,
    pub port: u16,
    /// Web pages at these origins may call the service from browsers, such as https://shop.example.com.
    pub cors_origins: Vec<String>,
}

/// The settings in these environment variables, or why one isn't valid.
pub fn load_config(env: &HashMap<String, String>) -> Result<Config, String> {
    let port = env.get("PORT").map_or("8080", String::as_str);
    let port = match port.parse::<u16>() {
        Ok(port) if port > 0 => port,
        _ => return Err("PORT must be a whole number between 1 and 65535.".to_owned()),
    };
    let cors_origins: Vec<String> = env
        .get("CORS_ORIGINS")
        .map_or("", String::as_str)
        .split(',')
        .map(str::trim)
        .filter(|origin| !origin.is_empty())
        .map(str::to_owned)
        .collect();
    if let Some(origin) = cors_origins.iter().find(|origin| !is_origin(origin)) {
        return Err(format!(
            "CORS_ORIGINS must list origins such as https://shop.example.com, and \"{origin}\" isn't one."
        ));
    }
    Ok(Config {
        host: env.get("HOST").cloned().unwrap_or_else(|| "0.0.0.0".to_owned()),
        port,
        cors_origins,
    })
}

/// Such as https://shop.example.com or http://localhost:49154: a scheme, a host and maybe a port.
fn is_origin(value: &str) -> bool {
    let Some(rest) = value.strip_prefix("https://").or_else(|| value.strip_prefix("http://")) else {
        return false;
    };
    let (host, port) = rest
        .split_once(':')
        .map_or((rest, None), |(host, port)| (host, Some(port)));
    !host.is_empty()
        && host.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-')
        && port.is_none_or(|port| !port.is_empty() && port.len() <= 5 && port.chars().all(|c| c.is_ascii_digit()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs
            .iter()
            .map(|(key, value)| ((*key).to_owned(), (*value).to_owned()))
            .collect()
    }

    #[test]
    fn uses_port_8080_on_every_network_interface_by_default_and_lets_no_web_page_call_it() {
        assert_eq!(
            load_config(&env(&[])),
            Ok(Config {
                host: "0.0.0.0".to_owned(),
                port: 8080,
                cors_origins: vec![]
            })
        );
    }

    #[test]
    fn refuses_a_port_that_is_not_valid() {
        for port in ["eighty", "0", "70000", "-1"] {
            assert!(load_config(&env(&[("PORT", port)]))
                .unwrap_err()
                .starts_with("PORT must be a whole number"));
        }
    }

    #[test]
    fn lets_the_web_pages_it_lists_call_it() {
        let config = load_config(&env(&[(
            "CORS_ORIGINS",
            " https://shop.example.com, http://localhost:49154 ,",
        )]))
        .unwrap();
        assert_eq!(
            config.cors_origins,
            vec!["https://shop.example.com", "http://localhost:49154"]
        );
    }

    #[test]
    fn refuses_something_that_is_not_an_origin() {
        for value in [
            "*",
            "shop.example.com",
            "https://shop.example.com/path",
            "https://",
            "http://host:",
        ] {
            assert!(load_config(&env(&[("CORS_ORIGINS", value)]))
                .unwrap_err()
                .starts_with("CORS_ORIGINS must list origins"));
        }
    }
}
