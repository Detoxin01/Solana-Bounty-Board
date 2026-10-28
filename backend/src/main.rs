use anchor_lang::{prelude::Pubkey, AccountDeserialize};
use axum::{
    body::Bytes,
    extract::{Path, State},
    http::{header, HeaderMap, HeaderValue, Method, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use bounty_board::{Bounty, BountyStatus, BOUNTY_SEED, ID as BOUNTY_PROGRAM_ID};
use ed25519_dalek::{Signature, VerifyingKey};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use sqlx::{
    sqlite::{SqliteConnectOptions, SqlitePoolOptions},
    FromRow, SqlitePool,
};
use std::{
    net::SocketAddr,
    str::FromStr,
    time::{SystemTime, UNIX_EPOCH},
};
use tower_http::{cors::CorsLayer, trace::TraceLayer};

#[derive(Clone)]
struct AppState {
    db: SqlitePool,
    rpc: Client,
    rpc_url: String,
}

#[derive(Debug, Serialize, FromRow)]
struct BountyMetadata {
    bounty_address: String,
    creator_address: String,
    title: String,
    description: String,
    created_at: String,
}

#[derive(Debug, Serialize, FromRow)]
struct SubmissionMetadata {
    worker_address: String,
    proof_url: String,
    submission_hash: String,
    created_at: String,
}

#[derive(Serialize)]
struct BountyDetail {
    metadata: BountyMetadata,
    submissions: Vec<SubmissionMetadata>,
}

#[derive(Deserialize)]
struct SaveBountyRequest {
    bounty_address: String,
    creator_address: String,
    title: String,
    description: String,
}

#[derive(Deserialize)]
struct SaveSubmissionRequest {
    worker_address: String,
    proof_url: String,
    submission_hash: String,
}

#[derive(Serialize)]
struct ApiErrorBody {
    error: String,
}

struct ApiError(StatusCode, String);

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.0, Json(ApiErrorBody { error: self.1 })).into_response()
    }
}

impl From<sqlx::Error> for ApiError {
    fn from(error: sqlx::Error) -> Self {
        tracing::error!(?error, "database request failed");
        Self(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Database request failed".into(),
        )
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    let db_options = SqliteConnectOptions::from_str("sqlite://bounty_board.db?mode=rwc")?
        .create_if_missing(true);
    let db = SqlitePoolOptions::new()
        .max_connections(5)
        .connect_with(db_options)
        .await?;
    let rpc_url = std::env::var("BOUNTY_RPC_URL")
        .unwrap_or_else(|_| "https://api.devnet.solana.com".to_string());

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS bounty_metadata (
            bounty_address TEXT PRIMARY KEY NOT NULL,
            creator_address TEXT NOT NULL,
            title TEXT NOT NULL,
            description TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )",
    )
    .execute(&db)
    .await?;

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS submission_metadata (
            bounty_address TEXT NOT NULL,
            worker_address TEXT NOT NULL,
            proof_url TEXT NOT NULL,
            submission_hash TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (bounty_address, worker_address)
        )",
    )
    .execute(&db)
    .await?;

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS used_wallet_nonces (
            nonce TEXT PRIMARY KEY NOT NULL,
            wallet_address TEXT NOT NULL,
            timestamp_ms INTEGER NOT NULL
        )",
    )
    .execute(&db)
    .await?;

    let cors = CorsLayer::new()
        .allow_origin("http://localhost:3000".parse::<HeaderValue>()?)
        .allow_methods([Method::GET, Method::POST, Method::PUT])
        .allow_headers([
            header::CONTENT_TYPE,
            "x-wallet-address".parse::<header::HeaderName>()?,
            "x-wallet-timestamp".parse::<header::HeaderName>()?,
            "x-wallet-nonce".parse::<header::HeaderName>()?,
            "x-wallet-signature".parse::<header::HeaderName>()?,
        ]);

    let app = Router::new()
        .route("/health", get(health))
        .route("/api/bounties", get(list_bounties).post(save_bounty))
        .route("/api/bounties/{address}", get(get_bounty))
        .route("/api/bounties/{address}/submissions", post(save_submission))
        .with_state(AppState {
            db,
            rpc: Client::new(),
            rpc_url,
        })
        .layer(cors)
        .layer(TraceLayer::new_for_http());

    let address = SocketAddr::from(([127, 0, 0, 1], 8080));
    let listener = tokio::net::TcpListener::bind(address).await?;
    tracing::info!(%address, "Bounty Board API is listening");
    axum::serve(listener, app).await?;
    Ok(())
}

async fn health() -> &'static str {
    "ok"
}

async fn fetch_onchain_bounty(state: &AppState, address: &str) -> Result<Bounty, ApiError> {
    let bounty_address = Pubkey::from_str(address)
        .map_err(|_| ApiError(StatusCode::BAD_REQUEST, "Invalid bounty address".into()))?;
    let response = state
        .rpc
        .post(&state.rpc_url)
        .json(&json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "getAccountInfo",
            "params": [address, { "encoding": "base64", "commitment": "confirmed" }]
        }))
        .send()
        .await
        .map_err(|error| {
            tracing::error!(?error, "Solana RPC request failed");
            ApiError(
                StatusCode::SERVICE_UNAVAILABLE,
                "Solana RPC is unavailable".into(),
            )
        })?;
    let response = response.error_for_status().map_err(|error| {
        tracing::error!(?error, "Solana RPC returned an HTTP error");
        ApiError(
            StatusCode::BAD_GATEWAY,
            "Solana RPC returned an error".into(),
        )
    })?;
    let payload = response
        .json::<serde_json::Value>()
        .await
        .map_err(|error| {
            tracing::error!(?error, "Could not decode Solana RPC response");
            ApiError(
                StatusCode::BAD_GATEWAY,
                "Invalid Solana RPC response".into(),
            )
        })?;
    if payload.get("error").is_some() {
        tracing::error!(rpc_error = %payload["error"], "Solana RPC reported an error");
        return Err(ApiError(
            StatusCode::BAD_GATEWAY,
            "Solana RPC request failed".into(),
        ));
    }

    let account = payload
        .pointer("/result/value")
        .filter(|value| !value.is_null())
        .ok_or_else(|| {
            ApiError(
                StatusCode::NOT_FOUND,
                "Bounty account does not exist on Devnet".into(),
            )
        })?;
    let program_address = BOUNTY_PROGRAM_ID.to_string();
    if account["owner"].as_str() != Some(program_address.as_str()) {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "Account is not owned by the Bounty Board program".into(),
        ));
    }
    let encoded_data = account["data"][0].as_str().ok_or_else(|| {
        ApiError(
            StatusCode::BAD_GATEWAY,
            "Bounty account data is missing".into(),
        )
    })?;
    let decoded_data = BASE64.decode(encoded_data).map_err(|_| {
        ApiError(
            StatusCode::BAD_GATEWAY,
            "Bounty account data is invalid".into(),
        )
    })?;
    let mut account_data = decoded_data.as_slice();
    let bounty = Bounty::try_deserialize(&mut account_data).map_err(|_| {
        ApiError(
            StatusCode::BAD_REQUEST,
            "Account is not a valid bounty".into(),
        )
    })?;

    let id_bytes = bounty.id.to_le_bytes();
    let (expected_address, _) = Pubkey::find_program_address(
        &[BOUNTY_SEED, bounty.creator.as_ref(), &id_bytes],
        &BOUNTY_PROGRAM_ID,
    );
    if expected_address != bounty_address {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "Bounty address does not match its on-chain data".into(),
        ));
    }

    Ok(bounty)
}

async fn list_bounties(
    State(state): State<AppState>,
) -> Result<Json<Vec<BountyMetadata>>, ApiError> {
    let rows = sqlx::query_as::<_, BountyMetadata>(
        "SELECT bounty_address, creator_address, title, description, created_at
         FROM bounty_metadata ORDER BY created_at DESC",
    )
    .fetch_all(&state.db)
    .await?;
    Ok(Json(rows))
}

async fn get_bounty(
    State(state): State<AppState>,
    Path(address): Path<String>,
) -> Result<Json<BountyDetail>, ApiError> {
    let metadata = sqlx::query_as::<_, BountyMetadata>(
        "SELECT bounty_address, creator_address, title, description, created_at
         FROM bounty_metadata WHERE bounty_address = ?",
    )
    .bind(address)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| ApiError(StatusCode::NOT_FOUND, "Bounty metadata not found".into()))?;

    let submissions = sqlx::query_as::<_, SubmissionMetadata>(
        "SELECT worker_address, proof_url, submission_hash, created_at
         FROM submission_metadata WHERE bounty_address = ? ORDER BY created_at DESC",
    )
    .bind(&metadata.bounty_address)
    .fetch_all(&state.db)
    .await?;

    Ok(Json(BountyDetail {
        metadata,
        submissions,
    }))
}

async fn save_bounty(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<(StatusCode, Json<BountyMetadata>), ApiError> {
    let signer = authenticate_wallet(&state, &headers, "POST", "/api/bounties", &body).await?;
    let request: SaveBountyRequest = serde_json::from_slice(&body).map_err(|_| {
        ApiError(
            StatusCode::BAD_REQUEST,
            "Invalid bounty request body".into(),
        )
    })?;
    validate_address(&request.bounty_address)?;
    validate_address(&request.creator_address)?;
    validate_text(&request.title, 1, 80, "title")?;
    validate_text(&request.description, 1, 2000, "description")?;

    let onchain = fetch_onchain_bounty(&state, &request.bounty_address).await?;
    if onchain.creator.to_string() != request.creator_address {
        return Err(ApiError(
            StatusCode::FORBIDDEN,
            "Creator does not match the on-chain bounty owner".into(),
        ));
    }
    if signer != request.creator_address {
        return Err(ApiError(
            StatusCode::FORBIDDEN,
            "Sign with the wallet that created this bounty".into(),
        ));
    }

    let row = sqlx::query_as::<_, BountyMetadata>(
        "INSERT INTO bounty_metadata (bounty_address, creator_address, title, description)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (bounty_address) DO UPDATE SET
            title = excluded.title,
            description = excluded.description
         WHERE bounty_metadata.creator_address = excluded.creator_address
         RETURNING bounty_address, creator_address, title, description, created_at",
    )
    .bind(request.bounty_address)
    .bind(request.creator_address)
    .bind(request.title)
    .bind(request.description)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| {
        ApiError(
            StatusCode::CONFLICT,
            "Only the original creator can update this metadata".into(),
        )
    })?;

    Ok((StatusCode::CREATED, Json(row)))
}

async fn save_submission(
    State(state): State<AppState>,
    Path(address): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<StatusCode, ApiError> {
    let path = format!("/api/bounties/{address}/submissions");
    let signer = authenticate_wallet(&state, &headers, "POST", &path, &body).await?;
    let request: SaveSubmissionRequest = serde_json::from_slice(&body).map_err(|_| {
        ApiError(
            StatusCode::BAD_REQUEST,
            "Invalid submission request body".into(),
        )
    })?;
    validate_address(&address)?;
    validate_address(&request.worker_address)?;
    validate_text(&request.proof_url, 1, 500, "proof_url")?;
    if !request.proof_url.starts_with("https://") && !request.proof_url.starts_with("ipfs://") {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "proof_url must start with https:// or ipfs://".into(),
        ));
    }
    if request.submission_hash.len() != 64
        || !request
            .submission_hash
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit())
    {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "submission_hash must be 64 hexadecimal characters".into(),
        ));
    }

    let onchain = fetch_onchain_bounty(&state, &address).await?;
    if onchain.status != BountyStatus::Submitted {
        return Err(ApiError(
            StatusCode::CONFLICT,
            "Bounty has no on-chain submission yet".into(),
        ));
    }
    if onchain.worker.to_string() != request.worker_address {
        return Err(ApiError(
            StatusCode::FORBIDDEN,
            "Worker does not match the on-chain submission".into(),
        ));
    }
    if signer != request.worker_address {
        return Err(ApiError(
            StatusCode::FORBIDDEN,
            "Sign with the wallet that submitted this work".into(),
        ));
    }
    let proof_hash: [u8; 32] = Sha256::digest(request.proof_url.trim().as_bytes()).into();
    if proof_hash != onchain.submission_hash
        || decode_hash(&request.submission_hash) != Some(onchain.submission_hash)
    {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "Proof link hash does not match the on-chain submission".into(),
        ));
    }

    sqlx::query(
        "INSERT INTO submission_metadata (bounty_address, worker_address, proof_url, submission_hash)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (bounty_address, worker_address) DO UPDATE SET
            proof_url = excluded.proof_url,
            submission_hash = excluded.submission_hash",
    )
    .bind(address)
    .bind(request.worker_address)
    .bind(request.proof_url)
    .bind(request.submission_hash.to_ascii_lowercase())
    .execute(&state.db)
    .await?;

    Ok(StatusCode::CREATED)
}

async fn authenticate_wallet(
    state: &AppState,
    headers: &HeaderMap,
    method: &str,
    path: &str,
    body: &[u8],
) -> Result<String, ApiError> {
    const MAX_AGE_MS: i64 = 5 * 60 * 1000;

    let header_value = |name: &str| {
        headers
            .get(name)
            .and_then(|value| value.to_str().ok())
            .ok_or_else(|| {
                ApiError(
                    StatusCode::UNAUTHORIZED,
                    "Wallet signature headers are missing".into(),
                )
            })
    };
    let wallet = header_value("x-wallet-address")?;
    let timestamp_text = header_value("x-wallet-timestamp")?;
    let nonce = header_value("x-wallet-nonce")?;
    let signature_text = header_value("x-wallet-signature")?;

    let wallet_bytes = bs58::decode(wallet)
        .into_vec()
        .map_err(|_| ApiError(StatusCode::UNAUTHORIZED, "Wallet address is invalid".into()))?;
    let wallet_bytes: [u8; 32] = wallet_bytes
        .try_into()
        .map_err(|_| ApiError(StatusCode::UNAUTHORIZED, "Wallet address is invalid".into()))?;
    let timestamp_ms = timestamp_text.parse::<i64>().map_err(|_| {
        ApiError(
            StatusCode::UNAUTHORIZED,
            "Wallet signature timestamp is invalid".into(),
        )
    })?;
    if nonce.len() != 36
        || !nonce
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() || byte == b'-')
    {
        return Err(ApiError(
            StatusCode::UNAUTHORIZED,
            "Wallet signature nonce is invalid".into(),
        ));
    }
    let signature_bytes = BASE64.decode(signature_text).map_err(|_| {
        ApiError(
            StatusCode::UNAUTHORIZED,
            "Wallet signature is invalid".into(),
        )
    })?;
    let signature = Signature::from_slice(&signature_bytes).map_err(|_| {
        ApiError(
            StatusCode::UNAUTHORIZED,
            "Wallet signature is invalid".into(),
        )
    })?;

    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| {
            ApiError(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Server clock is invalid".into(),
            )
        })?
        .as_millis() as i64;
    if timestamp_ms < now_ms - MAX_AGE_MS || timestamp_ms > now_ms + MAX_AGE_MS {
        return Err(ApiError(
            StatusCode::UNAUTHORIZED,
            "Wallet signature expired; please try again".into(),
        ));
    }

    let body_hash = Sha256::digest(body);
    let body_hash_hex = body_hash
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    let message = format!(
        "Bounty Board API request\nmethod: {method}\npath: {path}\nwallet: {wallet}\ntimestamp: {timestamp_ms}\nnonce: {nonce}\nbody-sha256: {body_hash_hex}"
    );
    let verifying_key = VerifyingKey::from_bytes(&wallet_bytes)
        .map_err(|_| ApiError(StatusCode::UNAUTHORIZED, "Wallet address is invalid".into()))?;
    verifying_key
        .verify_strict(message.as_bytes(), &signature)
        .map_err(|_| {
            ApiError(
                StatusCode::UNAUTHORIZED,
                "Wallet signature does not match this request".into(),
            )
        })?;

    let inserted = sqlx::query(
        "INSERT INTO used_wallet_nonces (nonce, wallet_address, timestamp_ms) VALUES (?, ?, ?)
         ON CONFLICT (nonce) DO NOTHING",
    )
    .bind(nonce)
    .bind(wallet)
    .bind(timestamp_ms)
    .execute(&state.db)
    .await?;
    if inserted.rows_affected() != 1 {
        return Err(ApiError(
            StatusCode::UNAUTHORIZED,
            "This wallet signature was already used".into(),
        ));
    }
    let _ = sqlx::query("DELETE FROM used_wallet_nonces WHERE timestamp_ms < ?")
        .bind(now_ms - 24 * 60 * 60 * 1000)
        .execute(&state.db)
        .await;

    Ok(wallet.to_owned())
}

fn validate_address(value: &str) -> Result<(), ApiError> {
    let decoded = bs58::decode(value)
        .into_vec()
        .map_err(|_| ApiError(StatusCode::BAD_REQUEST, "Invalid Solana address".into()))?;
    if decoded.len() != 32 {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "Invalid Solana address".into(),
        ));
    }
    Ok(())
}

fn decode_hash(value: &str) -> Option<[u8; 32]> {
    if value.len() != 64 {
        return None;
    }
    let mut result = [0_u8; 32];
    for (index, byte) in result.iter_mut().enumerate() {
        let start = index * 2;
        *byte = u8::from_str_radix(&value[start..start + 2], 16).ok()?;
    }
    Some(result)
}

fn validate_text(value: &str, min: usize, max: usize, field: &str) -> Result<(), ApiError> {
    let length = value.trim().chars().count();
    if length < min || length > max {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            format!("{field} must contain between {min} and {max} characters"),
        ));
    }
    Ok(())
}
