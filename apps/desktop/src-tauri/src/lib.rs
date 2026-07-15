use rand::Rng;
use std::{
    fs::{self, File},
    net::{IpAddr, Ipv4Addr, SocketAddr, TcpStream},
    os::unix::process::CommandExt,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{Arc, Mutex},
    thread,
    time::{Duration, Instant},
};
use tauri::{Manager, RunEvent};

struct Runtime {
    children: Arc<Mutex<Vec<Child>>>,
}

fn binary_dir() -> Result<PathBuf, String> {
    std::env::current_exe()
        .map_err(|error| error.to_string())?
        .parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| "Desktop binary has no parent directory".to_string())
}

fn bundled_resource(root: &Path, name: &str) -> PathBuf {
    let direct = root.join(name);
    if direct.exists() {
        direct
    } else {
        root.join("resources").join(name)
    }
}

fn secret(name: &str) -> Result<String, String> {
    let service = "design.contextlayer.app";
    let existing = Command::new("/usr/bin/security")
        .args(["find-generic-password", "-s", service, "-a", name, "-w"])
        .output()
        .map_err(|error| error.to_string())?;
    if existing.status.success() {
        return Ok(String::from_utf8_lossy(&existing.stdout).trim().to_string());
    }
    const CHARSET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    let mut rng = rand::rng();
    let value: String = (0..64)
        .map(|_| CHARSET[rng.random_range(0..CHARSET.len())] as char)
        .collect();
    let stored = Command::new("/usr/bin/security")
        .args([
            "add-generic-password",
            "-U",
            "-s",
            service,
            "-a",
            name,
            "-w",
            &value,
        ])
        .status()
        .map_err(|error| error.to_string())?;
    if !stored.success() {
        return Err(format!("Could not store {name} in macOS Keychain"));
    }
    Ok(value)
}

fn wait_for_port(port: u16, timeout: Duration) -> Result<(), String> {
    let address = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port);
    let started = Instant::now();
    while started.elapsed() < timeout {
        if TcpStream::connect_timeout(&address, Duration::from_millis(250)).is_ok() {
            return Ok(());
        }
        thread::sleep(Duration::from_millis(200));
    }
    Err(format!("Local service on port {port} did not start"))
}

fn ensure_port_free(port: u16) -> Result<(), String> {
    let address = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port);
    if TcpStream::connect_timeout(&address, Duration::from_millis(200)).is_ok() {
        return Err(format!("Local port {port} is already in use"));
    }
    Ok(())
}

fn terminate(child: &mut Child) {
    if child.try_wait().ok().flatten().is_some() {
        return;
    }
    let _ = Command::new("/bin/kill")
        .args(["-TERM", &format!("-{}", child.id())])
        .status();
    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline {
        if child.try_wait().ok().flatten().is_some() {
            return;
        }
        thread::sleep(Duration::from_millis(100));
    }
    let _ = child.kill();
    let _ = child.wait();
}

fn terminate_all(children: &Arc<Mutex<Vec<Child>>>) {
    if let Ok(mut children) = children.lock() {
        for child in children.iter_mut().rev() {
            terminate(child);
        }
        children.clear();
    }
}

fn database_exists(psql: &Path, library_path: &Path) -> Result<bool, String> {
    let output = Command::new(psql)
        .args([
            "-h",
            "127.0.0.1",
            "-p",
            "31422",
            "-U",
            "contextlayer",
            "-d",
            "postgres",
            "-tAc",
            "SELECT 1 FROM pg_database WHERE datname='contextlayer'",
        ])
        .env("DYLD_LIBRARY_PATH", library_path)
        .output()
        .map_err(|error| error.to_string())?;
    if !output.status.success() {
        return Err("Could not inspect the local database".into());
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim() == "1")
}

fn backup_database(pg_dump: &Path, library_path: &Path, destination: &Path) -> Result<(), String> {
    let status = Command::new(pg_dump)
        .args([
            "-h",
            "127.0.0.1",
            "-p",
            "31422",
            "-U",
            "contextlayer",
            "-d",
            "contextlayer",
            "--format=custom",
            "--create",
            "--file",
            destination.to_string_lossy().as_ref(),
        ])
        .env("DYLD_LIBRARY_PATH", library_path)
        .status()
        .map_err(|error| error.to_string())?;
    if !status.success() {
        let _ = fs::remove_file(destination);
        return Err("Could not back up the local database".into());
    }
    Ok(())
}

fn restore_requested_backup(
    marker: &Path,
    backups: &Path,
    psql: &Path,
    pg_restore: &Path,
    library_path: &Path,
) -> Result<bool, String> {
    if !marker.exists() {
        return Ok(false);
    }
    let requested = PathBuf::from(
        fs::read_to_string(marker)
            .map_err(|error| error.to_string())?
            .trim(),
    );
    let backups = backups.canonicalize().map_err(|error| error.to_string())?;
    let requested = requested
        .canonicalize()
        .map_err(|error| error.to_string())?;
    if !requested.starts_with(&backups)
        || requested.extension().and_then(|v| v.to_str()) != Some("dump")
    {
        return Err(
            "The requested restore file is outside the Context Layer backup directory".into(),
        );
    }
    let drop_status = Command::new(psql)
        .args([
            "-h",
            "127.0.0.1",
            "-p",
            "31422",
            "-U",
            "contextlayer",
            "-d",
            "postgres",
            "-v",
            "ON_ERROR_STOP=1",
            "-c",
            "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='contextlayer' AND pid <> pg_backend_pid(); DROP DATABASE IF EXISTS contextlayer;",
        ])
        .env("DYLD_LIBRARY_PATH", library_path)
        .status()
        .map_err(|error| error.to_string())?;
    if !drop_status.success() {
        return Err("Could not prepare the local database for restore".into());
    }
    let restore_status = Command::new(pg_restore)
        .args([
            "-h",
            "127.0.0.1",
            "-p",
            "31422",
            "-U",
            "contextlayer",
            "-d",
            "postgres",
            "--create",
            "--exit-on-error",
            requested.to_string_lossy().as_ref(),
        ])
        .env("DYLD_LIBRARY_PATH", library_path)
        .status()
        .map_err(|error| error.to_string())?;
    if !restore_status.success() {
        return Err("Could not restore the selected database backup".into());
    }
    fs::remove_file(marker).map_err(|error| error.to_string())?;
    Ok(true)
}

fn log_file(logs: &Path, name: &str) -> Result<(Stdio, Stdio), String> {
    let stdout = File::options()
        .create(true)
        .append(true)
        .open(logs.join(format!("{name}.log")))
        .map_err(|error| error.to_string())?;
    let stderr = stdout.try_clone().map_err(|error| error.to_string())?;
    Ok((Stdio::from(stdout), Stdio::from(stderr)))
}

fn launch(app: &tauri::AppHandle, children: Arc<Mutex<Vec<Child>>>) -> Result<(), String> {
    for port in [31420, 31421, 31422] {
        ensure_port_free(port)?;
    }
    let data = std::env::var_os("CONTEXT_LAYER_DATA_DIR")
        .map(PathBuf::from)
        .unwrap_or(
            app.path()
                .home_dir()
                .map_err(|error| error.to_string())?
                .join("Library")
                .join("Application Support")
                .join("Context Layer"),
        );
    let database = data.join("database");
    let logs = data.join("logs");
    let backups = data.join("backups");
    let sockets = data.join("run");
    for directory in [&data, &database, &logs, &backups, &sockets] {
        fs::create_dir_all(directory).map_err(|error| error.to_string())?;
    }

    let resource = app
        .path()
        .resource_dir()
        .map_err(|error| error.to_string())?;
    let binaries = binary_dir()?;
    let postgres_bundle = bundled_resource(&resource, "postgres");
    let postgres = postgres_bundle.join("bin/postgres");
    let initdb = postgres_bundle.join("bin/initdb");
    let pg_dump = postgres_bundle.join("bin/pg_dump");
    let pg_restore = postgres_bundle.join("bin/pg_restore");
    let psql = postgres_bundle.join("bin/psql");
    let agent = binaries.join("context-agent");
    let studio = binaries.join("studio");
    let studio_runtime = bundled_resource(&resource, "studio");
    let prototype_compiler = binaries.join("prototype-compiler");
    let media_extractor = binaries.join("media-extractor");
    let library_path = postgres_bundle.join("lib");

    if !database.join("PG_VERSION").exists() {
        let status = Command::new(&initdb)
            .args([
                "-D",
                database.to_string_lossy().as_ref(),
                "--username=contextlayer",
                "--auth=trust",
                "--encoding=UTF8",
            ])
            .env("DYLD_LIBRARY_PATH", &library_path)
            .status()
            .map_err(|error| error.to_string())?;
        if !status.success() {
            return Err("Could not initialize the local database".into());
        }
    }

    let (stdout, stderr) = log_file(&logs, "postgres")?;
    let mut postgres_command = Command::new(&postgres);
    postgres_command
        .args([
            "-D",
            database.to_string_lossy().as_ref(),
            "-h",
            "127.0.0.1",
            "-p",
            "31422",
            "-k",
            sockets.to_string_lossy().as_ref(),
            "-c",
            "shared_buffers=64MB",
            "-c",
            "max_connections=20",
            "-c",
            "work_mem=4MB",
            "-c",
            "maintenance_work_mem=32MB",
        ])
        .env("DYLD_LIBRARY_PATH", &library_path)
        .stdout(stdout)
        .stderr(stderr);
    postgres_command.process_group(0);
    let postgres_child = postgres_command
        .spawn()
        .map_err(|error| error.to_string())?;
    children
        .lock()
        .map_err(|_| "Runtime lock failed")?
        .push(postgres_child);
    wait_for_port(31422, Duration::from_secs(30))?;

    let existed = database_exists(&psql, &library_path)?;
    if existed {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|error| error.to_string())?
            .as_secs();
        backup_database(
            &pg_dump,
            &library_path,
            &backups.join(format!("startup-{stamp}.dump")),
        )?;
    }
    let restored = restore_requested_backup(
        &data.join("restore-request"),
        &backups,
        &psql,
        &pg_restore,
        &library_path,
    )?;
    if !existed && !restored {
        let created = Command::new(postgres_bundle.join("bin/createdb"))
            .args([
                "-h",
                "127.0.0.1",
                "-p",
                "31422",
                "-U",
                "contextlayer",
                "contextlayer",
            ])
            .env("DYLD_LIBRARY_PATH", &library_path)
            .status()
            .map_err(|error| error.to_string())?;
        if !created.success() {
            return Err("Could not create the local Context Layer database".into());
        }
    }
    let vector_status = Command::new(&psql)
        .args([
            "-h",
            "127.0.0.1",
            "-p",
            "31422",
            "-U",
            "contextlayer",
            "-d",
            "contextlayer",
            "-c",
            "CREATE EXTENSION IF NOT EXISTS vector",
        ])
        .env("DYLD_LIBRARY_PATH", &library_path)
        .status()
        .map_err(|error| error.to_string())?;
    if !vector_status.success() {
        return Err("The bundled PostgreSQL runtime is missing pgvector".into());
    }

    let auth_secret = secret("better-auth-secret")?;
    let encryption_key = secret("connection-encryption-key")?;
    let (stdout, stderr) = log_file(&logs, "context-agent")?;
    let mut agent_command = Command::new(&agent);
    agent_command
        .env(
            "DATABASE_URL",
            "postgres://contextlayer@127.0.0.1:31422/contextlayer",
        )
        .env("BETTER_AUTH_SECRET", auth_secret)
        .env("CONNECTION_ENCRYPTION_KEY", encryption_key)
        .env(
            "CONTEXT_LAYER_KEYCHAIN_SERVICE",
            "design.contextlayer.app.connectors",
        )
        .env("BETTER_AUTH_URL", "http://127.0.0.1:31421")
        .env("STUDIO_URL", "http://127.0.0.1:31420")
        .env("PORT", "31421")
        .env("AUTO_MIGRATE", "true")
        .env("MIGRATIONS_DIR", bundled_resource(&resource, "migrations"))
        .env("STUDIO_RUNTIME_DIR", bundled_resource(&resource, "studio"))
        .env("MEDIA_EXTRACTOR_PATH", media_extractor)
        .env("PROTOTYPE_COMPILER_PATH", prototype_compiler)
        .env("CONTEXT_LAYER_DATA_DIR", &data)
        .env("PG_DUMP_PATH", &pg_dump)
        .env("PGHOST", "127.0.0.1")
        .env("PGPORT", "31422")
        .env("PGUSER", "contextlayer")
        .env("PGDATABASE", "contextlayer")
        .env("CONNECTOR_POLLING", "false")
        .env("MODEL_CONCURRENCY", "1")
        .env("NODE_ENV", "production")
        .stdout(stdout)
        .stderr(stderr);
    agent_command.process_group(0);
    let agent_child = agent_command.spawn().map_err(|error| error.to_string())?;
    children
        .lock()
        .map_err(|_| "Runtime lock failed")?
        .push(agent_child);
    wait_for_port(31421, Duration::from_secs(45))?;

    let (stdout, stderr) = log_file(&logs, "studio")?;
    let mut studio_command = Command::new(&studio);
    studio_command
        .arg(studio_runtime.join("apps/studio/server.js"))
        .current_dir(studio_runtime.join("apps/studio"))
        .env("NEXT_PUBLIC_API_URL", "http://127.0.0.1:31421")
        .env("HOSTNAME", "127.0.0.1")
        .env("PORT", "31420")
        .env("NODE_ENV", "production")
        .stdout(stdout)
        .stderr(stderr);
    studio_command.process_group(0);
    let studio_child = studio_command.spawn().map_err(|error| error.to_string())?;
    children
        .lock()
        .map_err(|_| "Runtime lock failed")?
        .push(studio_child);
    wait_for_port(31420, Duration::from_secs(45))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let children = Arc::new(Mutex::new(Vec::<Child>::new()));
    let runtime = Runtime {
        children: children.clone(),
    };
    let app = tauri::Builder::default()
        .manage(runtime)
        .setup(move |app| {
            let handle = app.handle().clone();
            let children = children.clone();
            tauri::async_runtime::spawn_blocking(move || {
                if let Err(error) = launch(&handle, children.clone()) {
                    eprintln!("Context Layer startup failed: {error}");
                    terminate_all(&children);
                    handle.exit(1);
                }
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Context Layer");

    app.run(|app, event| {
        if matches!(event, RunEvent::Exit | RunEvent::ExitRequested { .. }) {
            terminate_all(&app.state::<Runtime>().children);
        }
    });
}
