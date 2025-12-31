-- Device Tracking Schema
-- Enables multi-device support with device scope tracking
-- Version: 1.0
-- Date: 2025-12-29

-- Enable required extensions (if not already enabled)
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ============================================================================
-- DEVICES TABLE
-- ============================================================================
-- Registry of all connected devices (WSL, Windows, Termux, etc.)

CREATE TABLE IF NOT EXISTS devices (
    device_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    device_name TEXT NOT NULL UNIQUE,       -- "WSL-xeres", "Windows-xeres", "Termux-Pixel"
    os_type TEXT NOT NULL,                  -- "linux", "windows", "android", "darwin"
    hostname TEXT,
    ip_address INET,
    first_seen TIMESTAMPTZ DEFAULT NOW(),
    last_seen TIMESTAMPTZ DEFAULT NOW(),
    is_active BOOLEAN DEFAULT TRUE,
    capabilities JSONB DEFAULT '{}'::jsonb, -- {"can_execute_tasks": true, "has_gpu": true}
    metadata JSONB DEFAULT '{}'::jsonb,     -- CPU, RAM, storage, etc.
    CONSTRAINT valid_os_type CHECK (os_type IN ('linux', 'windows', 'android', 'darwin', 'other'))
);

CREATE INDEX idx_devices_name ON devices(device_name);
CREATE INDEX idx_devices_active ON devices(is_active);
CREATE INDEX idx_devices_os ON devices(os_type);
CREATE INDEX idx_devices_last_seen ON devices(last_seen);

COMMENT ON TABLE devices IS 'Registry of all connected devices in the multi-device orchestrator';
COMMENT ON COLUMN devices.capabilities IS 'Device capabilities (can_execute_tasks, has_gpu, available_clis, etc.)';
COMMENT ON COLUMN devices.metadata IS 'Device metadata (CPU model, RAM size, disk space, etc.)';

-- ============================================================================
-- PROJECT DEVICES TABLE
-- ============================================================================
-- Defines which devices can access each project

CREATE TABLE IF NOT EXISTS project_devices (
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    device_id UUID NOT NULL REFERENCES devices(device_id) ON DELETE CASCADE,
    scope TEXT NOT NULL DEFAULT 'available',  -- 'primary', 'available', 'excluded'
    sync_enabled BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    modified_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (project_id, device_id),
    CONSTRAINT valid_scope CHECK (scope IN ('primary', 'available', 'excluded'))
);

CREATE INDEX idx_project_devices_project ON project_devices(project_id);
CREATE INDEX idx_project_devices_device ON project_devices(device_id);
CREATE INDEX idx_project_devices_scope ON project_devices(scope);

COMMENT ON TABLE project_devices IS 'Defines device accessibility for projects';
COMMENT ON COLUMN project_devices.scope IS 'primary = main development device, available = can access, excluded = explicitly hidden';

-- ============================================================================
-- TASK DEVICES TABLE
-- ============================================================================
-- Device-specific task assignments and execution preferences

CREATE TABLE IF NOT EXISTS task_devices (
    task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    device_id UUID NOT NULL REFERENCES devices(device_id) ON DELETE CASCADE,
    can_execute BOOLEAN DEFAULT TRUE,       -- Can this device execute the task?
    preferred BOOLEAN DEFAULT FALSE,        -- Is this device preferred for execution?
    created_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (task_id, device_id)
);

CREATE INDEX idx_task_devices_task ON task_devices(task_id);
CREATE INDEX idx_task_devices_device ON task_devices(device_id);
CREATE INDEX idx_task_devices_preferred ON task_devices(preferred) WHERE preferred = TRUE;

COMMENT ON TABLE task_devices IS 'Device-specific task execution preferences';

-- ============================================================================
-- EXTEND EXISTING TABLES
-- ============================================================================

-- Add device_scope to projects table
ALTER TABLE projects
    ADD COLUMN IF NOT EXISTS device_scope TEXT DEFAULT 'global',
    ADD CONSTRAINT valid_device_scope CHECK (device_scope IN ('global', 'local', 'os_specific', 'custom'));

CREATE INDEX idx_projects_device_scope ON projects(device_scope);

COMMENT ON COLUMN projects.device_scope IS 'global = all devices, local = specific devices, os_specific = by OS, custom = use project_devices table';

-- Add device_scope to tasks table
ALTER TABLE tasks
    ADD COLUMN IF NOT EXISTS device_scope TEXT DEFAULT 'inherit',
    ADD CONSTRAINT valid_task_device_scope CHECK (device_scope IN ('inherit', 'global', 'local', 'os_specific', 'custom'));

CREATE INDEX idx_tasks_device_scope ON tasks(device_scope);

COMMENT ON COLUMN tasks.device_scope IS 'inherit = use project scope, others same as projects.device_scope';

-- Add created_device_id to track where project/task was created
ALTER TABLE projects ADD COLUMN IF NOT EXISTS created_device_id UUID REFERENCES devices(device_id) ON DELETE SET NULL;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS created_device_id UUID REFERENCES devices(device_id) ON DELETE SET NULL;

CREATE INDEX idx_projects_created_device ON projects(created_device_id);
CREATE INDEX idx_tasks_created_device ON tasks(created_device_id);

-- ============================================================================
-- HELPER FUNCTIONS
-- ============================================================================

-- Function to register or update device
CREATE OR REPLACE FUNCTION register_device(
    p_device_name TEXT,
    p_os_type TEXT,
    p_hostname TEXT DEFAULT NULL,
    p_ip_address INET DEFAULT NULL,
    p_capabilities JSONB DEFAULT '{}'::jsonb,
    p_metadata JSONB DEFAULT '{}'::jsonb
)
RETURNS UUID AS $$
DECLARE
    v_device_id UUID;
BEGIN
    -- Try to find existing device
    SELECT device_id INTO v_device_id
    FROM devices
    WHERE device_name = p_device_name;

    IF v_device_id IS NULL THEN
        -- Create new device
        INSERT INTO devices (device_name, os_type, hostname, ip_address, capabilities, metadata)
        VALUES (p_device_name, p_os_type, p_hostname, p_ip_address, p_capabilities, p_metadata)
        RETURNING device_id INTO v_device_id;
    ELSE
        -- Update existing device
        UPDATE devices
        SET
            last_seen = NOW(),
            hostname = COALESCE(p_hostname, hostname),
            ip_address = COALESCE(p_ip_address, ip_address),
            capabilities = p_capabilities,
            metadata = p_metadata,
            is_active = TRUE
        WHERE device_id = v_device_id;
    END IF;

    RETURN v_device_id;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION register_device IS 'Register or update a device in the registry';

-- Function to mark device as inactive
CREATE OR REPLACE FUNCTION mark_device_inactive(p_device_name TEXT)
RETURNS VOID AS $$
BEGIN
    UPDATE devices
    SET is_active = FALSE
    WHERE device_name = p_device_name;
END;
$$ LANGUAGE plpgsql;

-- Function to get projects accessible from device
CREATE OR REPLACE FUNCTION get_device_projects(p_device_id UUID)
RETURNS TABLE (
    project_id UUID,
    name TEXT,
    status TEXT,
    device_scope TEXT,
    access_scope TEXT
) AS $$
BEGIN
    RETURN QUERY
    SELECT
        p.id,
        p.name,
        p.status,
        p.device_scope,
        COALESCE(pd.scope, 'available') as access_scope
    FROM projects p
    LEFT JOIN project_devices pd ON p.id = pd.project_id AND pd.device_id = p_device_id
    WHERE
        -- Global projects are always accessible
        p.device_scope = 'global'
        -- Or device is explicitly listed
        OR pd.scope IN ('primary', 'available')
    ORDER BY p.modified_at DESC;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION get_device_projects IS 'Get all projects accessible from a specific device';

-- ============================================================================
-- TRIGGERS
-- ============================================================================

-- Update modified_at on project_devices
CREATE OR REPLACE FUNCTION update_project_devices_modified()
RETURNS TRIGGER AS $$
BEGIN
    NEW.modified_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER project_devices_modified
    BEFORE UPDATE ON project_devices
    FOR EACH ROW
    EXECUTE FUNCTION update_project_devices_modified();

-- Auto-create project_device entry when project is created as 'local' or 'custom'
CREATE OR REPLACE FUNCTION auto_create_project_device()
RETURNS TRIGGER AS $$
BEGIN
    -- If project is local or custom and has a created_device_id, add to project_devices
    IF NEW.device_scope IN ('local', 'custom') AND NEW.created_device_id IS NOT NULL THEN
        INSERT INTO project_devices (project_id, device_id, scope)
        VALUES (NEW.id, NEW.created_device_id, 'primary')
        ON CONFLICT (project_id, device_id) DO NOTHING;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER auto_create_project_device_trigger
    AFTER INSERT ON projects
    FOR EACH ROW
    EXECUTE FUNCTION auto_create_project_device();

-- ============================================================================
-- SAMPLE DATA (for testing)
-- ============================================================================

-- Register example devices (commented out - uncomment for testing)
-- SELECT register_device('WSL-xeres', 'linux', 'xeres', '192.168.50.100'::inet);
-- SELECT register_device('Windows-xeres', 'windows', 'xeres', '192.168.50.100'::inet);
-- SELECT register_device('Termux-Pixel', 'android', 'Pixel-6', '192.168.50.105'::inet);

-- ============================================================================
-- MIGRATION COMPLETE
-- ============================================================================

-- Log migration
DO $$
BEGIN
    RAISE NOTICE 'Device tracking schema initialized successfully';
    RAISE NOTICE 'Tables created: devices, project_devices, task_devices';
    RAISE NOTICE 'Functions created: register_device, mark_device_inactive, get_device_projects';
END $$;
