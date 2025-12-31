# Multi-Device PostgreSQL Setup

**Goal**: Central PostgreSQL database on xeres, accessible from all devices

**Date**: 2025-12-29
**Status**: DESIGN PHASE

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                    xeres (192.168.50.100)                        │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │              PostgreSQL 16 (Central Database)               │ │
│  │  - knowledge_manager DB                                     │ │
│  │  - memory_items (vector embeddings)                         │ │
│  │  - device_registry (NEW)                                    │ │
│  │  - project_devices (NEW - device scope tracking)            │ │
│  │  - task_queue                                               │ │
│  └────────────────────────────────────────────────────────────┘ │
│           │                                                       │
│           │ Port 5432 (LAN access)                               │
└───────────┼───────────────────────────────────────────────────────┘
            │
    ┌───────┴──────────────────────────────────┐
    │                                           │
    ▼                                           ▼
┌─────────────┐                         ┌─────────────┐
│   WSL2      │                         │  Windows    │
│  (Ubuntu)   │                         │  (Pwsh7)    │
│             │                         │             │
│  kmtui ─────┼─────► PostgreSQL ◄─────┼───── kmtui  │
│  kmorch     │                         │             │
└─────────────┘                         └─────────────┘
                    │
                    ▼
            ┌─────────────┐
            │   Termux    │
            │  (Android)  │
            │             │
            │  kmtui ─────┼─────► PostgreSQL
            └─────────────┘
```

---

## Phase 1: PostgreSQL Network Setup (xeres)

### 1.1 Configure PostgreSQL for LAN Access

**File**: `/etc/postgresql/16/main/postgresql.conf`
```conf
# Listen on all interfaces (or specific LAN IP)
listen_addresses = '*'  # or '192.168.50.100'

# Connection limits
max_connections = 100

# Performance tuning for multi-device
shared_buffers = 256MB
effective_cache_size = 1GB
```

**File**: `/etc/postgresql/16/main/pg_hba.conf`
```conf
# Allow LAN connections with password authentication
# TYPE  DATABASE        USER            ADDRESS                 METHOD

# Local connections
local   all             all                                     peer
host    all             all             127.0.0.1/32            scram-sha-256
host    all             all             ::1/128                 scram-sha-256

# LAN connections (192.168.50.x network)
host    knowledge_manager  km_user      192.168.50.0/24         scram-sha-256
host    all             all             192.168.50.0/24         scram-sha-256
```

### 1.2 Restart PostgreSQL
```bash
sudo systemctl restart postgresql
```

### 1.3 Verify LAN Access
```bash
# From another device on LAN
psql -h 192.168.50.100 -U km_user -d knowledge_manager -c "SELECT COUNT(*) FROM projects;"
```

---

## Phase 2: Database Schema - Device Tracking

### 2.1 New Tables

**devices table** - Registry of all connected devices
```sql
CREATE TABLE devices (
    device_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    device_name TEXT NOT NULL,              -- "WSL-xeres", "Windows-xeres", "Termux-Pixel"
    os_type TEXT NOT NULL,                  -- "linux", "windows", "android"
    hostname TEXT,
    ip_address INET,
    first_seen TIMESTAMPTZ DEFAULT NOW(),
    last_seen TIMESTAMPTZ DEFAULT NOW(),
    is_active BOOLEAN DEFAULT TRUE,
    metadata JSONB DEFAULT '{}'::jsonb      -- CPU, RAM, etc.
);

CREATE INDEX idx_devices_name ON devices(device_name);
CREATE INDEX idx_devices_active ON devices(is_active);
```

**project_devices table** - Which devices can access each project
```sql
CREATE TABLE project_devices (
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    device_id UUID NOT NULL REFERENCES devices(device_id) ON DELETE CASCADE,
    scope TEXT NOT NULL DEFAULT 'available',  -- 'primary', 'available', 'excluded'
    sync_enabled BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (project_id, device_id)
);

CREATE INDEX idx_project_devices_project ON project_devices(project_id);
CREATE INDEX idx_project_devices_device ON project_devices(device_id);
CREATE INDEX idx_project_devices_scope ON project_devices(scope);
```

**task_devices table** - Device-specific task assignments
```sql
CREATE TABLE task_devices (
    task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    device_id UUID NOT NULL REFERENCES devices(device_id) ON DELETE CASCADE,
    can_execute BOOLEAN DEFAULT TRUE,       -- Can this device execute the task?
    preferred BOOLEAN DEFAULT FALSE,        -- Is this device preferred for execution?
    created_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (task_id, device_id)
);

CREATE INDEX idx_task_devices_task ON task_devices(task_id);
CREATE INDEX idx_task_devices_device ON task_devices(device_id);
```

### 2.2 Device Scope Enum

```sql
-- Scope types
-- 'global': Available on all devices
-- 'local': Only on specific device(s)
-- 'os_specific': Only on devices with specific OS
-- 'mixed': Different components on different devices

ALTER TABLE projects ADD COLUMN device_scope TEXT DEFAULT 'global';
ALTER TABLE tasks ADD COLUMN device_scope TEXT DEFAULT 'inherit';  -- inherit from project

CREATE INDEX idx_projects_device_scope ON projects(device_scope);
```

---

## Phase 3: Client Configuration (All Devices)

### 3.1 Environment Variables

**File**: `~/.zshrc` (WSL), `$PROFILE` (PowerShell), `~/.bashrc` (Termux)

```bash
# PostgreSQL connection (ALL DEVICES)
export KM_DB_TYPE=postgresql
export KM_POSTGRES_HOST=192.168.50.100    # xeres LAN IP
export KM_POSTGRES_PORT=5432
export KM_POSTGRES_DB=knowledge_manager
export KM_POSTGRES_USER=km_user
export KM_POSTGRES_PASSWORD=<secure_password>

# Device identification
export KM_DEVICE_NAME="WSL-xeres"         # Unique per device
export KM_DEVICE_OS="linux"               # linux/windows/android
export KM_DEVICE_HOSTNAME="$(hostname)"

# Task queue (network share or device-local)
export TASK_QUEUE_PATH="/mnt/share/ai-orchestrator/task_queue"  # Network share
# OR
export TASK_QUEUE_PATH="$HOME/.local/ai-orchestrator/task_queue"  # Local
```

### 3.2 Network Share Setup (Optional)

**For task queue sharing across devices:**

**xeres (NFS server)**:
```bash
# /etc/exports
/home/mcarls/projects/ai-orchestrator/task_queue 192.168.50.0/24(rw,sync,no_subtree_check)
```

**Clients (mount NFS)**:
```bash
# WSL/Linux
sudo mount -t nfs 192.168.50.100:/path/to/task_queue /mnt/share/task_queue

# Windows
net use T: \\192.168.50.100\task_queue

# Termux (if supported)
# Use SMB via termux-share or similar
```

---

## Phase 4: TUI Updates - Device Scope Display

### 4.1 Project List View

**Show device scope badges:**
```
╭─────────────────────────────────────────────────╮
│ Projects:                                       │
│                                                  │
│ [🌍 Global] ai-orchestrator                     │
│ [🖥️  WSL] Linux Scripts                         │
│ [🪟 Win] Windows PowerShell                     │
│ [📱 Android] Termux Setup                       │
│ [🔀 Mixed] Cross-Platform Utils                 │
╰─────────────────────────────────────────────────╯
```

**Legend:**
- 🌍 Global: Available on all devices
- 🖥️ Device-specific: Only on this device
- 🪟 Windows-only
- 📱 Android-only
- 🔀 Mixed: Different parts on different devices

### 4.2 Task Assignment UI

**When assigning to AI (Ctrl+A):**
```
╭─────────────────────────────────────────────────╮
│ Assign Task to AI                               │
│                                                  │
│ Task: "Implement authentication"                │
│ Project: ai-orchestrator                        │
│                                                  │
│ Execution Device:                               │
│   ⦿ Any available device (default)              │
│   ○ This device only (WSL-xeres)                │
│   ○ Windows devices only                        │
│   ○ Linux devices only                          │
│   ○ Specific device: [Select...]                │
│                                                  │
│ CLI Preference:                                 │
│   ⦿ claude (available on: WSL, Windows)         │
│   ○ codex (available on: WSL)                   │
│   ○ gemini (available on: All)                  │
│                                                  │
│ [Assign] [Cancel]                               │
╰─────────────────────────────────────────────────╯
```

### 4.3 Device Status Panel

**Show in orchestrator viewer:**
```
╭─ Connected Devices ──────────────────────────────╮
│ 🟢 WSL-xeres (192.168.50.100) - 2 workers       │
│ 🟢 Windows-xeres (192.168.50.100) - 1 worker    │
│ 🟡 Termux-Pixel (192.168.50.105) - idle         │
│ 🔴 Windows-laptop (offline - 2h ago)            │
╰──────────────────────────────────────────────────╯
```

---

## Phase 5: Device Registration Flow

### 5.1 Auto-registration on First Connect

**When kmtui starts:**
```python
def register_device():
    """Auto-register device on first connection."""
    device_name = os.getenv("KM_DEVICE_NAME")
    device_os = os.getenv("KM_DEVICE_OS")
    hostname = os.getenv("KM_DEVICE_HOSTNAME")

    # Get local IP
    import socket
    ip_address = socket.gethostbyname(socket.gethostname())

    # Check if device exists
    device = get_device_by_name(device_name)

    if not device:
        # First time - register
        device_id = create_device(
            device_name=device_name,
            os_type=device_os,
            hostname=hostname,
            ip_address=ip_address
        )
        notify(f"Device registered: {device_name}", title="Welcome!")
    else:
        # Update last_seen
        update_device_last_seen(device.id)
```

### 5.2 Project Scope Configuration

**In kmtui, when creating project:**
```
╭─────────────────────────────────────────────────╮
│ New Project                                     │
│                                                  │
│ Name: ai-orchestrator                           │
│                                                  │
│ Device Scope:                                   │
│   ⦿ Global (all devices)                        │
│   ○ Local (this device only)                    │
│   ○ Windows only                                │
│   ○ Linux only                                  │
│   ○ Android only                                │
│   ○ Custom (select devices)                     │
│                                                  │
│ [Create] [Cancel]                               │
╰─────────────────────────────────────────────────╯
```

---

## Phase 6: Firewall Configuration

### 6.1 xeres Firewall (Ubuntu/WSL)

```bash
# Allow PostgreSQL from LAN
sudo ufw allow from 192.168.50.0/24 to any port 5432 comment 'PostgreSQL LAN'

# If using NFS for task queue
sudo ufw allow from 192.168.50.0/24 to any port 2049 comment 'NFS'

# Reload
sudo ufw reload
```

### 6.2 Windows Firewall

```powershell
# Allow PostgreSQL from LAN
New-NetFirewallRule -DisplayName "PostgreSQL LAN" `
    -Direction Inbound `
    -Protocol TCP `
    -LocalPort 5432 `
    -RemoteAddress 192.168.50.0/24 `
    -Action Allow
```

---

## Phase 7: Testing Multi-Device Setup

### 7.1 Test Checklist

**From WSL (xeres)**:
- [ ] Connect to local PostgreSQL
- [ ] Create test project (scope: global)
- [ ] Verify in database

**From Windows (same machine)**:
- [ ] Connect to PostgreSQL on 192.168.50.100
- [ ] See test project in kmtui
- [ ] Create task on test project
- [ ] Assign task to AI (Ctrl+A)

**From Termux (Android)**:
- [ ] Connect to PostgreSQL on 192.168.50.100
- [ ] See all global projects
- [ ] Create device-specific project
- [ ] Verify WSL doesn't see device-specific project

**Orchestrator Viewer (kmorch)**:
- [ ] See all 3 devices connected
- [ ] Watch task queue update from all devices
- [ ] See worker assignments

---

## Migration Plan for Existing Devices

### For Windows & Termux (Current SQLite users)

**Don't migrate! Just configure:**

1. Pull latest code from scripts repo
2. Set environment variables (see Phase 3.1)
3. Restart kmtui
4. Projects will appear from central database

**No data migration needed** - data is already in xeres PostgreSQL!

---

## Security Considerations

### 7.1 Password Security

- Use strong password for km_user
- Store in environment variable, not in code
- Consider using ~/.pgpass for password-less auth:

```bash
# ~/.pgpass (chmod 600)
192.168.50.100:5432:knowledge_manager:km_user:your_secure_password
```

### 7.2 SSL/TLS (Future)

For production, enable SSL:
```conf
# postgresql.conf
ssl = on
ssl_cert_file = '/path/to/server.crt'
ssl_key_file = '/path/to/server.key'
```

---

## Rollback Plan

If multi-device setup fails:

1. Keep PostgreSQL on xeres for WSL only
2. Other devices use read-only access or sync mechanism
3. Investigate network issues (firewall, DNS, routing)

---

## Next Steps

1. [ ] Configure PostgreSQL for LAN access on xeres
2. [ ] Add device tracking tables to schema
3. [ ] Update kmtui with device registration
4. [ ] Add device scope UI to project creation
5. [ ] Test from Windows and Termux
6. [ ] Update orchestrator viewer with device panel

---

**End of Multi-Device Setup Guide**
