//! The `sunstone-server` binary behind Sunstone Web: the whole surface is
//! [`sunstone_server::serve_from_env`] (configuration is entirely via env).

#[tokio::main]
async fn main() {
    sunstone_server::serve_from_env().await
}
