// AI Orchestrator Web Viewer - Frontend Application

// State
let ws = null;
let currentView = 'dashboard';
const storedProjectId = window.localStorage.getItem('selectedProjectId');
let selectedProject = storedProjectId || null;
let activeProjectFilter = selectedProject || null;
let selectedTask = null;
let memorySearchTerm = '';
let memorySemanticActive = false;
let memorySemanticResults = [];
let dbSchemaCache = null;
let dbTrendsCache = null;
let currentSystemView = 'stats';
let projectTracking = {};
let availableModels = [];
let projectsCache = [];
let selectedTaskDetails = null;
let trackingErrorMessage = '';
let lastTrackingErrorAt = 0;
let astProgressTimer = null;
const TRACKING_ERROR_COOLDOWN_MS = 15000;
const TASK_STATUSES = [
    { value: 'todo', label: 'Todo' },
    { value: 'in-progress', label: 'In Progress' },
    { value: 'done', label: 'Done' },
];
const DEFAULT_ACTIVE_STATUSES = ['todo', 'in-progress'];
let activeTaskStatuses = new Set(DEFAULT_ACTIVE_STATUSES);
const logViewerSettings = {
    minLevel: 'INFO',
    includeAccess: false,
    autoRefresh: true,
};
const UI_EVENT_ENDPOINT = '/api/telemetry/ui-event';
const PRIORITY_LOW = { r: 16, g: 185, b: 129 };   // #10b981
const PRIORITY_HIGH = { r: 239, g: 68, b: 68 };    // #ef4444
const TASK_INDENT_REM = 1.5;
const PROJECT_SORT_DEFAULTS = {
    activity: 'desc',
    name: 'asc',
    created: 'desc',
    completion: 'desc',
};
let projectSort = {
    field: 'activity',
    direction: PROJECT_SORT_DEFAULTS.activity,
};
const TASK_SORT_DEFAULTS = {
    updated: 'desc',
    created: 'desc',
    priority: 'desc',
    max_priority: 'desc',
    name: 'asc',
};
let taskSort = {
    field: 'updated',
    direction: TASK_SORT_DEFAULTS.updated,
};
const EMBEDDING_MODE_DESCRIPTIONS = {
    auto: 'Auto detects code vs text, parses AST for code, and indexes both.',
    code: 'Code-only: symbol-aware chunks with AST parsing (CodeBERT).',
    text: 'Text-only: documents and prose (BGE base).',
};

function logUiEvent(eventType, details = {}) {
    const payload = {
        event: eventType,
        details,
        view: currentView,
        timestamp: new Date().toISOString(),
    };
    fetch(UI_EVENT_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        keepalive: true,
    }).catch((error) => {
        console.warn('Failed to log UI event', eventType, error);
    });
}

function normalizeErrorDetail(detail) {
    if (!detail) return '';
    if (typeof detail === 'string') return detail;
    if (detail.detail) return detail.detail;
    if (detail.error) return detail.error;
    try {
        return JSON.stringify(detail);
    } catch (error) {
        return String(detail);
    }
}

function normalizeTaskStatusValue(status) {
    if (!status) return 'todo';
    if (status === 'in_progress') return 'in-progress';
    return status;
}

function approvalMetadata(action = 'webui-action') {
    return {
        approved: true,
        approved_by: action,
    };
}

function priorityToColor(priority = 5) {
    const value = Math.max(1, Math.min(10, Number(priority) || 5));
    const t = (value - 1) / 9;
    const r = Math.round(PRIORITY_LOW.r + (PRIORITY_HIGH.r - PRIORITY_LOW.r) * t);
    const g = Math.round(PRIORITY_LOW.g + (PRIORITY_HIGH.g - PRIORITY_LOW.g) * t);
    const b = Math.round(PRIORITY_LOW.b + (PRIORITY_HIGH.b - PRIORITY_LOW.b) * t);
    return `rgb(${r}, ${g}, ${b})`;
}

function formatTimeSince(isoString) {
    if (!isoString) return 'Never';
    const time = new Date(isoString).getTime();
    if (Number.isNaN(time)) return 'Unknown';
    const diffMs = Date.now() - time;
    const minutes = Math.floor(diffMs / 60000);
    if (minutes < 1) return 'Just now';
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 48) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
}

function setEmbeddingModeDescription(selectEl, descEl) {
    if (!selectEl || !descEl) return;
    const mode = selectEl.value || 'auto';
    descEl.textContent = EMBEDDING_MODE_DESCRIPTIONS[mode] || '';
}

function extractEmbeddingStats(stats) {
    if (!stats) return null;
    const code = stats.code?.project || stats.code?.global || stats.code || null;
    const text = stats.text?.summary || stats.text || null;
    return { code, text };
}

function formatEmbeddingStats(stats) {
    const extracted = extractEmbeddingStats(stats);
    if (!extracted) return '';
    const parts = [];
    if (extracted.code) {
        const astOk = extracted.code.ast_success ?? 0;
        const astFail = extracted.code.ast_failure ?? 0;
        const indexed = extracted.code.chunks_indexed ?? 0;
        const skipped = extracted.code.chunks_skipped ?? 0;
        parts.push(`AST: ${astOk} ok / ${astFail} fail`);
        parts.push(`Code chunks: ${indexed} indexed / ${skipped} skipped`);
    }
    if (extracted.text) {
        const textIndexed = extracted.text.chunks_indexed ?? 0;
        parts.push(`Text chunks: ${textIndexed} indexed`);
    }
    return parts.join(' · ');
}

function buildTaskHierarchy(tasks = [], rootComparator = null, visibleIds = null) {
    const taskMap = new Map();
    tasks.forEach((task, order) => {
        taskMap.set(task.id, { ...task, children: [], order });
    });

    const roots = [];
    taskMap.forEach((node) => {
        if (node.parent_task_id && taskMap.has(node.parent_task_id)) {
            taskMap.get(node.parent_task_id).children.push(node);
        } else {
            roots.push(node);
        }
    });

    const sortedRoots = [...roots];
    if (typeof rootComparator === 'function') {
        sortedRoots.sort(rootComparator);
    } else {
        sortedRoots.sort((a, b) => a.order - b.order);
    }

    const ordered = [];

    function traverse(nodes, depth, ancestry = []) {
        nodes.forEach((node, index) => {
            const children = [...node.children].sort((a, b) => a.order - b.order);
            const isLast = index === nodes.length - 1;
            if (!visibleIds || visibleIds.has(node.id)) {
                ordered.push({
                    task: node,
                    depth,
                    isLast,
                    ancestorContinuations: ancestry,
                    hasChildren: children.length > 0,
                });
            }
            if (children.length) {
                traverse(children, depth + 1, [...ancestry, !isLast]);
            }
        });
    }

    traverse(sortedRoots, 0, []);
    return ordered;
}

function renderTaskCard(entry) {
    const { task, depth, ancestorContinuations, isLast, hasChildren } = entry;
    const priorityValue = task.priority ?? 5;
    const priorityLabel = priorityValue ? `P${priorityValue}` : 'P?';
    const color = priorityToColor(priorityValue);
    const connectors = ancestorContinuations
        .map((active, idx) => active
            ? `<span class="connector vertical" style="--connector-depth:${idx};"></span>`
            : '')
        .join('');
    const elbow = depth > 0
        ? `<span class="connector elbow ${isLast ? 'last' : ''}" style="--connector-depth:${depth - 1};"></span>`
        : '';
    const connectorBlock = (depth > 0 || ancestorContinuations.some(Boolean))
        ? `<div class="task-card-connector">${connectors}${elbow}</div>`
        : '';

    return `
        <div class="task-card ${depth > 0 ? 'has-parent' : ''} ${hasChildren ? 'has-children' : ''} ${isLast ? 'is-last-child' : ''}"
             onclick="selectTask('${task.id}')"
             style="--task-depth:${depth}; --priority-color:${color};">
            ${connectorBlock}
            <div class="task-card-body">
                <div class="task-title-row">
                    <span class="title">${task.title}</span>
                    <span class="priority-pill">${priorityLabel}</span>
                </div>
                <div class="meta">
                    Status: ${task.status} |
                    Priority: ${task.priority || 'None'}
                </div>
            </div>
        </div>
    `;
}

function setActiveProject(projectId) {
    const normalized = projectId || null;
    selectedProject = normalized;
    activeProjectFilter = normalized;
    if (normalized) {
        window.localStorage.setItem('selectedProjectId', normalized);
    } else {
        window.localStorage.removeItem('selectedProjectId');
    }
    renderProjectTrackingBanner();
}

// Initialize on page load
document.addEventListener('DOMContentLoaded', () => {
    initializeNavigation();
    initializeWebSocket();
    loadDashboard();
    setupModelControls();
    setupManualTaskForm();
    setupMemoryControls();
    setupProjectCreation();
    initializeTrackingControls();
    initializeLogViewerControls();
    initializeTrackingForm();
    initializeTaskDetailForm();
    initializeTaskToolbar();
    initializeStatusFilters();
    initializeProjectSortControls();
    initializeTaskSortControls();
    setupStatsControls();
    setupDatabaseExplorerControls();
    setupSystemControls();
    setupLmstudioControls();
    initializeEmbeddingControls();
    initializeEmbeddingsView();
    startSystemMeter();

    // Refresh data every 5 seconds
    setInterval(refreshCurrentView, 5000);
});

// Navigation
function initializeNavigation() {
    document.querySelectorAll('.nav-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const view = e.target.dataset.view;
            logUiEvent('nav_click', { view });
            switchView(view, 'user');
        });
    });
}

function switchView(view, reason = 'user') {
    if (currentView === view) {
        return;
    }
    const previousView = currentView;

    // Update nav buttons
    document.querySelectorAll('.nav-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.view === view);
    });

    // Update views
    document.querySelectorAll('.view').forEach(v => {
        v.classList.toggle('active', v.id === `${view}-view`);
    });

    currentView = view;
    logUiEvent('view_switch', { from: previousView, to: view, reason });

    if (view !== 'tasks') {
        hideTrackingConfigPanel();
        hideTaskCreatePanel();
    }

    // Load view data
    switch(view) {
        case 'dashboard':
            loadDashboard();
            break;
        case 'orchestrator':
            loadOrchestrator();
            break;
        case 'tasks':
            loadTasks();
            break;
        case 'memory':
            loadMemoryView();
            break;
        case 'embeddings':
            loadEmbeddingsView();
            break;
        case 'system':
            switchSystemView(currentSystemView, true);
            break;
    }
}

function refreshCurrentView() {
    switch (currentView) {
        case 'dashboard':
            loadDashboard();
            break;
        case 'orchestrator':
            loadOrchestrator();
            break;
        case 'tasks':
            if (activeProjectFilter) {
                loadProjects()
                    .then(() => loadTasksList())
                    .catch((error) => console.error('Error refreshing tasks view:', error));
            } else {
                loadTasks();
            }
            break;
        case 'memory':
            loadMemoryView();
            break;
        case 'embeddings':
            loadEmbeddingsView();
            break;
        case 'system':
            switch (currentSystemView) {
                case 'stats':
                    loadSystemStats();
                    break;
                case 'database':
                    loadDatabaseView();
                    break;
                case 'lmstudio':
                    loadLmstudioView();
                    break;
                case 'logs':
                    if (logViewerSettings.autoRefresh) {
                        loadLogEntries();
                    }
                    break;
                default:
                    break;
            }
            break;
        default:
            break;
    }
}

// WebSocket Connection
function initializeWebSocket() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws`;

    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
        console.log('WebSocket connected');
        updateConnectionStatus(true);
    };

    ws.onclose = () => {
        console.log('WebSocket disconnected');
        updateConnectionStatus(false);
        // Reconnect after 5 seconds
        setTimeout(initializeWebSocket, 5000);
    };

    ws.onerror = (error) => {
        console.error('WebSocket error:', error);
        updateConnectionStatus(false);
    };

    ws.onmessage = (event) => {
        const message = JSON.parse(event.data);
        handleWebSocketMessage(message);
    };
}

function updateConnectionStatus(connected) {
    const statusEl = document.getElementById('connection-status');
    const dotEl = document.querySelector('.status-dot');

    if (connected) {
        statusEl.textContent = 'Connected';
        dotEl.style.background = 'var(--success)';
    } else {
        statusEl.textContent = 'Disconnected';
        dotEl.style.background = 'var(--error)';
    }
}

function handleWebSocketMessage(message) {
    console.log('WebSocket message:', message);

    switch(message.type) {
        case 'worker_status':
            updateWorkerStatus(message.data);
            break;
        case 'task_update':
            updateTaskStatus(message.data);
            break;
        case 'log':
            addLogLine(message.data);
            break;
        case 'task_complete':
            handleTaskComplete(message.data);
            break;
    }
}

// Dashboard
async function loadDashboard() {
    try {
        const stats = await fetch('/api/orchestrator/stats').then(r => r.json());

        document.getElementById('stat-workers').textContent = stats.active_workers || 0;
        document.getElementById('stat-queued').textContent = stats.queued || 0;
        document.getElementById('stat-completed').textContent = stats.completed || 0;
        document.getElementById('stat-failed').textContent = stats.failed || 0;
    } catch (error) {
        console.error('Error loading dashboard:', error);
    }
}

// Orchestrator View
async function loadOrchestrator() {
    await loadWorkers();
    await loadTaskQueue();
    await loadModelControls();
    if (!projectsCache.length) {
        await loadProjects();
    }
}

function setupModelControls() {
    const saveBtn = document.getElementById('model-save-btn');
    if (saveBtn) {
        saveBtn.addEventListener('click', saveModelSelection);
    }
}

function setupManualTaskForm() {
    const form = document.getElementById('manual-task-form');
    if (form) {
        form.addEventListener('submit', submitManualTask);
    }
}

function setupMemoryControls() {
    const refreshBtn = document.getElementById('memory-refresh-btn');
    const searchInput = document.getElementById('memory-search');
    const semanticBtn = document.getElementById('memory-semantic-btn');
    const semanticClearBtn = document.getElementById('memory-semantic-clear');
    const memoryAddForm = document.getElementById('memory-add-form');
    const memoryIndexForm = document.getElementById('memory-index-form');
    const semanticStatus = document.getElementById('memory-semantic-status');
    if (refreshBtn) {
        refreshBtn.addEventListener('click', () => {
            memorySearchTerm = searchInput ? searchInput.value.trim() : '';
            memorySemanticActive = false;
            memorySemanticResults = [];
            if (semanticStatus) {
                semanticStatus.textContent = '';
            }
            logUiEvent('memory_refresh', { query: memorySearchTerm });
            loadMemoryView();
        });
    }
    if (searchInput) {
        searchInput.addEventListener('keydown', (event) => {
            if (event.key === 'Enter') {
                memorySearchTerm = event.target.value.trim();
                memorySemanticActive = false;
                memorySemanticResults = [];
                if (semanticStatus) {
                    semanticStatus.textContent = '';
                }
                logUiEvent('memory_search', { query: memorySearchTerm });
                loadMemoryItems();
            }
        });
    }
    if (semanticBtn) {
        semanticBtn.addEventListener('click', handleMemorySemanticSearch);
    }
    if (semanticClearBtn) {
        semanticClearBtn.addEventListener('click', () => {
            memorySemanticActive = false;
            memorySemanticResults = [];
            if (semanticStatus) {
                semanticStatus.textContent = '';
            }
            loadMemoryView();
        });
    }
    if (memoryAddForm) {
        memoryAddForm.addEventListener('submit', handleMemoryAdd);
    }
    if (memoryIndexForm) {
        memoryIndexForm.addEventListener('submit', handleMemoryIndex);
    }
}

function initializeTrackingControls() {
    const configureBtn = document.getElementById('project-track-btn');
    const embedBtn = document.getElementById('project-embed-btn');
    const upgradeBtn = document.getElementById('project-upgrade-global-btn');
    const untrackBtn = document.getElementById('project-untrack-btn');
    const deleteBtn = document.getElementById('project-delete-btn');

    if (configureBtn) {
        configureBtn.addEventListener('click', showTrackingConfigPanel);
    }
    if (embedBtn) {
        embedBtn.addEventListener('click', startEmbeddingRun);
    }
    if (upgradeBtn) {
        upgradeBtn.addEventListener('click', upgradeProjectToGlobal);
    }
    if (untrackBtn) {
        untrackBtn.addEventListener('click', stopProjectTracking);
    }
    if (deleteBtn) {
        deleteBtn.addEventListener('click', handleProjectDelete);
    }
}

function setupProjectCreation() {
    const newProjectBtn = document.getElementById('new-project-btn');
    if (newProjectBtn) {
        newProjectBtn.addEventListener('click', createNewProject);
    }
}

function initializeProjectSortControls() {
    const orderSelect = document.getElementById('projects-order');
    const directionSelect = document.getElementById('projects-order-direction');
    if (orderSelect) {
        orderSelect.value = projectSort.field;
        orderSelect.addEventListener('change', (event) => {
            const selectedField = event.target.value;
            projectSort.field = selectedField;
            const defaultDirection = PROJECT_SORT_DEFAULTS[selectedField] || 'desc';
            projectSort.direction = defaultDirection;
            if (directionSelect) {
                directionSelect.value = defaultDirection;
            }
            logUiEvent('projects_sort_change', {
                field: projectSort.field,
                direction: projectSort.direction,
            });
            loadProjects();
        });
    }
    if (directionSelect) {
        directionSelect.value = projectSort.direction;
        directionSelect.addEventListener('change', (event) => {
            projectSort.direction = event.target.value;
            logUiEvent('projects_sort_direction', { direction: projectSort.direction });
            loadProjects();
        });
    }
}

function setupStatsControls() {
    const dockerBtn = document.getElementById('docker-refresh-btn');
    const dbBtn = document.getElementById('db-refresh-btn');
    const dbQueryBtn = document.getElementById('db-query-refresh-btn');
    const lmstudioBtn = document.getElementById('lmstudio-refresh-btn');
    if (dockerBtn) {
        dockerBtn.addEventListener('click', loadDockerStats);
    }
    if (dbBtn) {
        dbBtn.addEventListener('click', loadDbStats);
    }
    if (dbQueryBtn) {
        dbQueryBtn.addEventListener('click', loadDatabaseView);
    }
    if (lmstudioBtn) {
        lmstudioBtn.addEventListener('click', loadLmstudioStats);
    }
}

function setupDatabaseExplorerControls() {
    const buttons = document.querySelectorAll('.subnav-btn[data-db-view]');
    buttons.forEach((button) => {
        button.addEventListener('click', () => switchDbView(button.dataset.dbView || 'queries'));
    });
    const schemaRefresh = document.getElementById('db-schema-refresh');
    if (schemaRefresh) {
        schemaRefresh.addEventListener('click', loadDbSchema);
    }
    const schemaSelect = document.getElementById('db-schema-database');
    if (schemaSelect) {
        schemaSelect.addEventListener('change', () => renderDbSchema(dbSchemaCache));
    }
    const trendsAll = document.getElementById('db-trends-all');
    if (trendsAll) {
        trendsAll.addEventListener('click', () => setDbTrendsSelection(true));
    }
    const trendsNone = document.getElementById('db-trends-none');
    if (trendsNone) {
        trendsNone.addEventListener('click', () => setDbTrendsSelection(false));
    }
}

function setupSystemControls() {
    const buttons = document.querySelectorAll('.subnav-btn[data-system-view]');
    buttons.forEach((button) => {
        button.addEventListener('click', () => switchSystemView(button.dataset.systemView || 'stats'));
    });
}

function setupLmstudioControls() {
    const refreshBtn = document.getElementById('lmstudio-refresh-all');
    const modelsBtn = document.getElementById('lmstudio-models-refresh');
    const loadForm = document.getElementById('lmstudio-load-form');
    const unloadForm = document.getElementById('lmstudio-unload-form');
    const getForm = document.getElementById('lmstudio-get-form');
    const serverStart = document.getElementById('lmstudio-server-start');
    const serverStop = document.getElementById('lmstudio-server-stop');

    if (refreshBtn) {
        refreshBtn.addEventListener('click', loadLmstudioView);
    }
    if (modelsBtn) {
        modelsBtn.addEventListener('click', loadLmstudioModels);
    }
    if (loadForm) {
        loadForm.addEventListener('submit', handleLmstudioLoad);
    }
    if (unloadForm) {
        unloadForm.addEventListener('submit', handleLmstudioUnload);
    }
    if (getForm) {
        getForm.addEventListener('submit', handleLmstudioGet);
    }
    if (serverStart) {
        serverStart.addEventListener('click', () => handleLmstudioServer('start'));
    }
    if (serverStop) {
        serverStop.addEventListener('click', () => handleLmstudioServer('stop'));
    }
}
function initializeLogViewerControls() {
    const levelFilter = document.getElementById('logs-level-filter');
    if (levelFilter) {
        levelFilter.addEventListener('change', (event) => {
            logViewerSettings.minLevel = event.target.value;
            logUiEvent('logs_filter_level', { level: logViewerSettings.minLevel });
            loadLogEntries();
        });
    }

    const includeAccess = document.getElementById('logs-include-access');
    if (includeAccess) {
        includeAccess.addEventListener('change', (event) => {
            logViewerSettings.includeAccess = event.target.checked;
            logUiEvent('logs_include_access_toggle', { enabled: logViewerSettings.includeAccess });
            loadLogEntries();
        });
    }

    const autoToggle = document.getElementById('logs-auto-refresh');
    if (autoToggle) {
        autoToggle.addEventListener('change', (event) => {
            logViewerSettings.autoRefresh = event.target.checked;
            logUiEvent('logs_auto_refresh_toggle', { enabled: logViewerSettings.autoRefresh });
        });
    }

    const refreshBtn = document.getElementById('logs-refresh-btn');
    if (refreshBtn) {
        refreshBtn.addEventListener('click', () => {
            logUiEvent('logs_manual_refresh');
            loadLogEntries();
        });
    }

    const applyBtn = document.getElementById('apply-log-level-btn');
    if (applyBtn) {
        applyBtn.addEventListener('click', applyServerLogLevel);
    }
}

async function loadModelControls() {
    const select = document.getElementById('model-select');
    if (!select) return;
    try {
        const config = await fetch('/api/control/models').then(r => r.json());
        availableModels = config.models || [];
        select.innerHTML = config.models.map(model => `
            <option value="${model.id}">${model.label}</option>
        `).join('');
        if (config.current_model) {
            select.value = config.current_model;
        }
        populateTrackingModelSelect(
            document.getElementById('tracking-preferred-model'),
            undefined
        );
    } catch (error) {
        console.error('Error loading models:', error);
    }
}

async function saveModelSelection() {
    const select = document.getElementById('model-select');
    const status = document.getElementById('model-status');
    if (!select) return;

    logUiEvent('model_select', { model_id: select.value });
    try {
        await fetch('/api/control/models/select', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model_id: select.value })
        });
        if (status) {
            status.textContent = 'Model updated successfully';
        }
    } catch (error) {
        console.error('Error updating model:', error);
        if (status) {
            status.textContent = 'Failed to update model';
        }
    }
}

async function submitManualTask(event) {
    event.preventDefault();
    const form = event.target;
    const status = document.getElementById('manual-task-status');
    const formData = new FormData(form);
    const payload = Object.fromEntries(formData.entries());
    payload.priority = Number(payload.priority);
    Object.assign(payload, approvalMetadata('webui-manual-task'));
    if (!payload.working_dir) {
        delete payload.working_dir;
    }

    logUiEvent('manual_task_submit', {
        project_id: payload.project_id,
        cli: payload.cli_preference,
        priority: payload.priority,
    });

    try {
        const response = await fetch('/api/control/tasks', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const result = await response.json();
        if (!response.ok) {
            throw new Error(result.detail || 'Failed to queue task');
        }
        form.reset();
        if (status) {
            status.textContent = `Queued task ${result.task_id}`;
        }
        loadTaskQueue();
    } catch (error) {
        console.error('Error queuing manual task:', error);
        if (status) {
            status.textContent = `Error: ${error.message}`;
        }
    }
}

async function loadWorkers() {
    try {
        const workers = await fetch('/api/orchestrator/workers').then(r => r.json());
        const grid = document.getElementById('workers-grid');

        if (workers.length === 0) {
            grid.innerHTML = '<div class="empty-state">No active workers</div>';
            return;
        }

        grid.innerHTML = workers.map(worker => `
            <div class="worker-card">
                <h4>${worker.worker_id}</h4>
                <div class="task-title">${worker.task_title}</div>
                <div class="meta">
                    PID: ${worker.worker_pid || 'N/A'} |
                    CLI: ${worker.cli_preference}
                </div>
            </div>
        `).join('');
    } catch (error) {
        console.error('Error loading workers:', error);
    }
}

async function loadTaskQueue() {
    try {
        const tasks = await fetch('/api/orchestrator/tasks').then(r => r.json());

        updateQueueColumn('queued', tasks.queued || []);
        updateQueueColumn('progress', tasks.in_progress || []);
        updateQueueColumn('completed', tasks.completed || []);
        updateQueueColumn('failed', tasks.failed || []);
    } catch (error) {
        console.error('Error loading task queue:', error);
    }
}

function updateQueueColumn(status, tasks) {
    const list = document.getElementById(`queue-${status}`);
    const count = document.getElementById(`queue-${status}-count`);

    count.textContent = tasks.length;

    if (tasks.length === 0) {
        list.innerHTML = '<div class="empty-state">No tasks</div>';
        return;
    }

    list.innerHTML = tasks.map(task => {
        const ctx = task.context || {};
        const repoPath = (ctx.repo_paths && ctx.repo_paths[0]) || ctx.repo_path || '';
        const jobType = ctx.job_type || '';
        const extra = [jobType, repoPath].filter(Boolean).join(' | ');
        return `
        <div class="task-card" onclick="viewTaskLogs('${task.task_id}')">
            <div class="title">${task.task_title}</div>
            <div class="meta">${task.task_id.substring(0, 8)}...${extra ? ` | ${extra}` : ''}</div>
        </div>
    `;
    }).join('');
}

async function viewTaskLogs(taskId) {
    logUiEvent('task_logs_view', { task_id: taskId });
    try {
        const logs = await fetch(`/api/orchestrator/logs/${taskId}`).then(r => r.json());
        const logsContainer = document.getElementById('live-logs');

        logsContainer.innerHTML = `
            <div class="log-section">
                <h4>Task: ${taskId}</h4>
                <pre>${logs.stdout || 'No output yet'}</pre>
                ${logs.stderr ? `<h4>Errors:</h4><pre>${logs.stderr}</pre>` : ''}
            </div>
        `;
    } catch (error) {
        console.error('Error loading task logs:', error);
    }
}

function clearLogs() {
    document.getElementById('live-logs').innerHTML = '';
    logUiEvent('logs_clear');
}

function addLogLine(logData) {
    const logsContainer = document.getElementById('live-logs');
    const autoScroll = document.getElementById('auto-scroll').checked;

    const logLine = document.createElement('div');
    logLine.className = 'log-line';
    logLine.innerHTML = `
        <span class="timestamp">[${new Date(logData.timestamp).toLocaleTimeString()}]</span>
        <span class="level-${logData.level}">${logData.message}</span>
    `;

    logsContainer.appendChild(logLine);

    if (autoScroll) {
        logsContainer.scrollTop = logsContainer.scrollHeight;
    }
}

// Tasks View
async function loadTasks() {
    await loadProjects();
    // Preserve selected project filter when refreshing
    await loadTasksList();
    renderProjectTrackingBanner();
}

function setProjectsError(message = '') {
    const errorEl = document.getElementById('projects-error');
    if (!errorEl) {
        return;
    }
    if (message) {
        errorEl.textContent = message;
        errorEl.classList.remove('hidden');
    } else {
        errorEl.textContent = '';
        errorEl.classList.add('hidden');
    }
}

function renderProjectsList(projects = []) {
    const list = document.getElementById('projects-list');
    if (!list) {
        return;
    }
    if (!projects || projects.length === 0) {
        list.innerHTML = '<div class="empty-state">No projects</div>';
        return;
    }
    const orderedProjects = sortProjects(projects);
    list.innerHTML = orderedProjects.map(project => `
        <div class="project-item ${selectedProject === project.id ? 'active' : ''} ${projectStatusClass(project.id)}"
             onclick="selectProject('${project.id}')">
            ${project.name}
            ${renderProjectBadges(project.id)}
        </div>
    `).join('');
}

function sortProjects(projects = []) {
    const directionFactor = projectSort.direction === 'asc' ? 1 : -1;
    const ordered = [...projects];
    ordered.sort((a, b) => {
        const valueA = getProjectSortValue(a, projectSort.field);
        const valueB = getProjectSortValue(b, projectSort.field);
        let comparison = compareValues(valueA, valueB, directionFactor);
        if (comparison !== 0) {
            return comparison;
        }
        comparison = compareValues(
            (a.name || '').toLowerCase(),
            (b.name || '').toLowerCase(),
            1
        );
        if (comparison !== 0) {
            return comparison;
        }
        const createdDiff = getTimestamp(b.created_at) - getTimestamp(a.created_at);
        if (createdDiff !== 0) {
            return createdDiff;
        }
        return 0;
    });
    return ordered;
}

function getProjectSortValue(project, field) {
    switch (field) {
        case 'name':
            return (project.name || '').toLowerCase();
        case 'created':
            return getTimestamp(project.created_at);
        case 'completion':
            return getTimestamp(project.latest_task_completed);
        case 'activity':
        default:
            return getTimestamp(project.latest_task_activity || project.modified_at || project.created_at);
    }
}

function getTaskComparator() {
    const directionFactor = taskSort.direction === 'asc' ? 1 : -1;
    return (a, b) => {
        const valueA = getTaskSortValue(a, taskSort.field);
        const valueB = getTaskSortValue(b, taskSort.field);
        let comparison = compareValues(valueA, valueB, directionFactor);
        if (comparison !== 0) {
            return comparison;
        }
        comparison = compareValues(
            a.priority ?? 0,
            b.priority ?? 0,
            -1
        );
        if (comparison !== 0) {
            return comparison;
        }
        const updatedDiff = getTimestamp(b.modified_at) - getTimestamp(a.modified_at);
        if (updatedDiff !== 0) {
            return updatedDiff;
        }
        return compareValues(
            (a.title || '').toLowerCase(),
            (b.title || '').toLowerCase(),
            1
        );
    };
}

function sortTasks(tasks = []) {
    const comparator = getTaskComparator();
    const ordered = [...tasks];
    ordered.sort(comparator);
    return ordered;
}

function getTaskSortValue(task, field) {
    switch (field) {
        case 'created':
            return getTimestamp(task.created_at);
        case 'priority':
            return task.priority ?? 0;
        case 'max_priority':
            if (typeof task.max_subtask_priority === 'number') {
                return task.max_subtask_priority;
            }
            return task.max_subtask_priority ?? task.priority ?? 0;
        case 'name':
            return (task.title || '').toLowerCase();
        case 'updated':
        default:
            return getTimestamp(task.modified_at || task.created_at);
    }
}

function compareValues(a, b, directionFactor = 1) {
    const isString = typeof a === 'string' || typeof b === 'string';
    if (isString) {
        const strA = (a ?? '').toString();
        const strB = (b ?? '').toString();
        const comparison = strA.localeCompare(strB);
        if (comparison === 0) {
            return 0;
        }
        return comparison * directionFactor;
    }
    const numA = Number(a) || 0;
    const numB = Number(b) || 0;
    if (numA === numB) {
        return 0;
    }
    return numA > numB ? directionFactor : -directionFactor;
}

function getTimestamp(value) {
    if (!value) {
        return 0;
    }
    const date = new Date(value);
    const time = date.getTime();
    return Number.isNaN(time) ? 0 : time;
}

async function loadProjects() {
    try {
        const projects = await fetch('/api/projects').then(r => r.json());
        projectsCache = projects;
        refreshTaskProjectOptions();
        refreshManualTaskOptions();
        let trackingStatuses = [];
        try {
            const trackingResponse = await fetch('/api/project-tracking');
            if (!trackingResponse.ok) {
                throw new Error(`status ${trackingResponse.status}`);
            }
            trackingStatuses = await trackingResponse.json();
            clearTrackingError();
        } catch (trackingError) {
            console.warn('Failed to load tracking metadata:', trackingError);
            handleTrackingFetchError(trackingError.message || 'unknown');
        }
        projectTracking = {};
        (trackingStatuses || []).forEach(entry => {
            projectTracking[entry.project_id] = entry;
        });
        refreshManualTaskOptions();
        setProjectsError('');
        renderProjectsList(projects);
        renderProjectTrackingBanner();
    } catch (error) {
        console.error('Error loading projects:', error);
        if (projectsCache.length > 0) {
            setProjectsError('Unable to refresh projects. Showing cached list.');
            renderProjectsList(projectsCache);
        } else {
            const list = document.getElementById('projects-list');
            if (list) {
                list.innerHTML = '<div class="error-message">Failed to load projects</div>';
            }
            setProjectsError('Failed to load projects.');
        }
    }
}

async function loadTasksList(projectId) {
    const hasExplicitProject = typeof projectId !== 'undefined';
    const previousFilter = activeProjectFilter;
    let effectiveProjectId;
    if (hasExplicitProject) {
        effectiveProjectId = projectId;
    } else if (previousFilter) {
        effectiveProjectId = previousFilter;
    } else if (selectedProject) {
        effectiveProjectId = selectedProject;
    } else {
        effectiveProjectId = null;
    }
    activeProjectFilter = effectiveProjectId || null;

    const wasFiltered = !!previousFilter;
    const isFiltered = !!activeProjectFilter;

    if (!wasFiltered && isFiltered) {
        logUiEvent('tasks_filter_restore', { project_id: activeProjectFilter });
    } else if (wasFiltered && !isFiltered && hasExplicitProject) {
        logUiEvent('tasks_filter_reset', { previously_selected: previousFilter });
    }

    try {
        let url = '/api/tasks?limit=100';
        if (effectiveProjectId) {
            url += `&project_id=${effectiveProjectId}`;
        }

        const tasks = await fetch(url).then(r => r.json());
        const filteredTasks = filterTasksByStatus(tasks);
        const visibleIds = new Set(filteredTasks.map((task) => task.id));
        const rootComparator = getTaskComparator();
        const hierarchy = buildTaskHierarchy(tasks, rootComparator, visibleIds);
        const grid = document.getElementById('tasks-grid');

        if (hierarchy.length === 0) {
            grid.innerHTML = '<div class="empty-state">No tasks for selected filters</div>';
            resetTaskDetailPanel();
            return;
        }

        grid.innerHTML = hierarchy.map(renderTaskCard).join('');
    } catch (error) {
        console.error('Error loading tasks:', error);
    }
}

function selectProject(projectId) {
    setActiveProject(projectId);
    loadProjects();
    loadTasksList(projectId);
    hideTrackingConfigPanel();
    logUiEvent('project_select', { project_id: projectId });
}

async function selectTask(taskId) {
    selectedTask = taskId;
    logUiEvent('task_select', { task_id: taskId });

    try {
        const task = await fetch(`/api/tasks/${taskId}`).then(r => r.json());
        populateTaskDetailForm(task);
    } catch (error) {
        console.error('Error loading task details:', error);
    }
}

async function assignTaskToAI(taskId) {
    logUiEvent('task_assign_to_ai', { task_id: taskId });
    try {
        const response = await fetch(`/api/tasks/${taskId}/assign`, { method: 'POST' });
        if (!response.ok) {
            const payload = await response.json().catch(() => ({}));
            throw new Error(normalizeErrorDetail(payload) || `HTTP ${response.status}`);
        }
        alert('Task assigned to AI queue');
        // Switch to orchestrator view
        switchView('orchestrator', 'system');
    } catch (error) {
        console.error('Error assigning task:', error);
        alert('Failed to assign task: ' + error.message);
    }
}

function initializeTaskToolbar() {
    const newTaskBtn = document.getElementById('new-task-btn');
    const cancelBtn = document.getElementById('task-create-cancel');
    const closeBtn = document.getElementById('task-create-close');
    const form = document.getElementById('task-create-form');
    if (newTaskBtn) {
        newTaskBtn.addEventListener('click', () => showTaskCreatePanel({ mode: 'create' }));
    }
    if (cancelBtn) {
        cancelBtn.addEventListener('click', hideTaskCreatePanel);
    }
    if (closeBtn) {
        closeBtn.addEventListener('click', hideTaskCreatePanel);
    }
    if (form) {
        form.addEventListener('submit', handleTaskCreateSubmit);
    }
}

function initializeStatusFilters() {
    const checkboxes = document.querySelectorAll('.status-filter');
    checkboxes.forEach(cb => {
        cb.addEventListener('change', () => {
            const status = cb.dataset.status;
            if (cb.checked) {
                activeTaskStatuses.add(status);
            } else {
                activeTaskStatuses.delete(status);
            }
            logUiEvent('tasks_status_toggle', { status, enabled: cb.checked });
            if (activeTaskStatuses.size === 0) {
                activeTaskStatuses = new Set(DEFAULT_ACTIVE_STATUSES);
                syncStatusCheckboxes();
            }
            if (currentView === 'tasks') {
                loadTasksList();
            }
        });
    });
    const activeBtn = document.getElementById('status-select-active');
    const allBtn = document.getElementById('status-select-all');
    if (activeBtn) {
        activeBtn.addEventListener('click', () => {
            activeTaskStatuses = new Set(DEFAULT_ACTIVE_STATUSES);
            syncStatusCheckboxes();
            logUiEvent('tasks_status_presets', { preset: 'active' });
            if (currentView === 'tasks') {
                loadTasksList();
            }
        });
    }
    if (allBtn) {
        allBtn.addEventListener('click', () => {
            activeTaskStatuses = new Set(TASK_STATUSES.map(status => status.value));
            syncStatusCheckboxes();
            logUiEvent('tasks_status_presets', { preset: 'all' });
            if (currentView === 'tasks') {
                loadTasksList();
            }
        });
    }
    syncStatusCheckboxes();
}

function initializeTaskSortControls() {
    const orderSelect = document.getElementById('tasks-order');
    const directionSelect = document.getElementById('tasks-order-direction');
    if (orderSelect) {
        orderSelect.value = taskSort.field;
        orderSelect.addEventListener('change', (event) => {
            const selectedField = event.target.value;
            taskSort.field = selectedField;
            const defaultDirection = TASK_SORT_DEFAULTS[selectedField] || 'desc';
            taskSort.direction = defaultDirection;
            if (directionSelect) {
                directionSelect.value = defaultDirection;
            }
            logUiEvent('tasks_sort_change', {
                field: taskSort.field,
                direction: taskSort.direction,
            });
            if (currentView === 'tasks') {
                loadTasksList();
            }
        });
    }
    if (directionSelect) {
        directionSelect.value = taskSort.direction;
        directionSelect.addEventListener('change', (event) => {
            taskSort.direction = event.target.value;
            logUiEvent('tasks_sort_direction', { direction: taskSort.direction });
            if (currentView === 'tasks') {
                loadTasksList();
            }
        });
    }
}

function syncStatusCheckboxes() {
    document.querySelectorAll('.status-filter').forEach(cb => {
        const status = cb.dataset.status;
        cb.checked = activeTaskStatuses.has(status);
    });
}

function initializeTaskDetailForm() {
    const form = document.getElementById('task-detail-form');
    const deleteBtn = document.getElementById('task-detail-delete');
    const subtaskBtn = document.getElementById('task-detail-add-subtask');
    const assignBtn = document.getElementById('task-detail-assign');

    if (form) {
        form.addEventListener('submit', handleTaskUpdateSubmit);
    }
    if (deleteBtn) {
        deleteBtn.addEventListener('click', handleTaskDelete);
    }
    if (subtaskBtn) {
        subtaskBtn.addEventListener('click', handleAddSubtask);
    }
    if (assignBtn) {
        assignBtn.addEventListener('click', () => {
            if (selectedTask) {
                assignTaskToAI(selectedTask);
            }
        });
    }
}

function showTaskCreatePanel(options = {}) {
    const panel = document.getElementById('task-create-panel');
    const heading = document.getElementById('task-create-title');
    const titleInput = document.getElementById('task-create-title-input');
    const statusSelect = document.getElementById('task-create-status');
    const priorityInput = document.getElementById('task-create-priority');
    const projectSelect = document.getElementById('task-create-project');
    const parentInput = document.getElementById('task-create-parent-id');
    const statusText = document.getElementById('task-create-status-text');

    if (!panel || !titleInput || !statusSelect || !projectSelect || !priorityInput) {
        return;
    }

    const mode = options.mode || 'create';
    if (heading) {
        heading.textContent = mode === 'subtask' ? 'New Subtask' : 'New Task';
    }
    titleInput.value = options.title || '';
    renderStatusOptions(statusSelect, options.status || 'todo');
    priorityInput.value = options.priority || 5;
    populateProjectSelect(projectSelect, options.projectId || selectedProject || '');
    parentInput.value = options.parentTaskId || '';
    if (statusText) {
        statusText.textContent = '';
    }
    panel.dataset.mode = mode;
    panel.classList.remove('hidden');
    titleInput.focus();
}

function hideTaskCreatePanel() {
    const panel = document.getElementById('task-create-panel');
    const form = document.getElementById('task-create-form');
    const statusText = document.getElementById('task-create-status-text');
    if (panel) {
        panel.classList.add('hidden');
    }
    if (form) {
        form.reset();
    }
    if (statusText) {
        statusText.textContent = '';
    }
}

async function handleTaskCreateSubmit(event) {
    event.preventDefault();
    const titleInput = document.getElementById('task-create-title-input');
    const statusSelect = document.getElementById('task-create-status');
    const priorityInput = document.getElementById('task-create-priority');
    const projectSelect = document.getElementById('task-create-project');
    const parentInput = document.getElementById('task-create-parent-id');
    const statusText = document.getElementById('task-create-status-text');
    if (!titleInput || !statusSelect || !priorityInput) {
        return;
    }

    const payload = {
        title: titleInput.value.trim(),
        status: statusSelect.value,
        priority: Number(priorityInput.value) || 5,
        project_id: projectSelect && projectSelect.value ? projectSelect.value : undefined,
        parent_task_id: parentInput && parentInput.value ? parentInput.value : undefined,
    };

    if (!payload.title) {
        if (statusText) statusText.textContent = 'Title is required';
        return;
    }

    logUiEvent('task_create', {
        project_id: payload.project_id || null,
        parent_task_id: payload.parent_task_id || null,
    });

    try {
        const response = await fetch('/api/tasks', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
        const task = await response.json();
        if (!response.ok) {
            throw new Error(task.detail || 'Failed to create task');
        }
        hideTaskCreatePanel();
        if (task.project_id) {
            setActiveProject(task.project_id);
        }
        await loadProjects();
        await loadTasksList();
        selectedTask = task.id;
        populateTaskDetailForm(task);
    } catch (error) {
        console.error('Error creating task:', error);
        if (statusText) {
            statusText.textContent = error.message;
        }
    }
}

function renderStatusOptions(select, selectedValue = 'todo') {
    if (!select) return;
    select.innerHTML = TASK_STATUSES.map(status => `
        <option value="${status.value}">${status.label}</option>
    `).join('');
    select.value = selectedValue || 'todo';
}

function populateProjectSelect(select, selectedId = '') {
    if (!select) return;
    const ordered = [...projectsCache].sort((a, b) => {
        return (a.name || '').localeCompare(b.name || '', undefined, { sensitivity: 'base' });
    });
    const options = ordered.map(project => `
        <option value="${project.id}">${project.name}</option>
    `).join('');
    select.innerHTML = `<option value="">Unassigned</option>${options}`;
    select.value = selectedId || '';
}

function refreshTaskProjectOptions() {
    populateProjectSelect(document.getElementById('task-create-project'), selectedProject || '');
}

function refreshManualTaskOptions() {
    const select = document.getElementById('manual-task-project');
    if (!select) return;
    if (!projectsCache.length) {
        select.innerHTML = '<option value="">No projects found</option>';
        return;
    }
    const ordered = [...projectsCache].sort((a, b) => {
        return (a.name || '').localeCompare(b.name || '', undefined, { sensitivity: 'base' });
    });
    select.innerHTML = ordered
        .map(project => `<option value="${project.id}" ${project.id === selectedProject ? 'selected' : ''}>${project.name}</option>`)
        .join('');

    const datalist = document.getElementById('manual-task-paths');
    if (!datalist) return;
    const paths = new Set();
    Object.values(projectTracking || {}).forEach((entry) => {
        (entry.repo_paths || []).forEach((path) => paths.add(path));
        if (entry.repo_path) paths.add(entry.repo_path);
    });
    datalist.innerHTML = Array.from(paths)
        .map((path) => `<option value="${path}"></option>`)
        .join('');
}

function getProjectName(projectId) {
    if (!projectId) {
        return '—';
    }
    const project = projectsCache.find(p => p.id === projectId);
    return project ? project.name : projectId;
}

function filterTasksByStatus(tasks = []) {
    if (!activeTaskStatuses || activeTaskStatuses.size === 0) {
        return tasks;
    }
    return tasks.filter(task => activeTaskStatuses.has(normalizeTaskStatusValue(task.status)));
}

function populateTaskDetailForm(task) {
    selectedTaskDetails = task;
    const form = document.getElementById('task-detail-form');
    const emptyState = document.getElementById('task-empty-state');
    const titleInput = document.getElementById('task-detail-title');
    const statusSelect = document.getElementById('task-detail-status');
    const priorityInput = document.getElementById('task-detail-priority');
    const metaEl = document.getElementById('task-detail-meta');
    const statusText = document.getElementById('task-detail-status-text');

    if (!form || !titleInput || !statusSelect || !priorityInput) {
        return;
    }

    titleInput.value = task.title || '';
    renderStatusOptions(statusSelect, normalizeTaskStatusValue(task.status));
    priorityInput.value = task.priority || 5;
    if (metaEl) {
        metaEl.innerHTML = `
            <div><strong>Project:</strong> ${getProjectName(task.project_id)}</div>
            <div><strong>Created:</strong> ${formatDate(task.created_at)}</div>
            <div><strong>Updated:</strong> ${formatDate(task.modified_at)}</div>
        `;
    }
    if (statusText) {
        statusText.textContent = '';
    }
    form.classList.remove('hidden');
    if (emptyState) {
        emptyState.classList.add('hidden');
    }
}

function resetTaskDetailPanel() {
    selectedTask = null;
    selectedTaskDetails = null;
    const form = document.getElementById('task-detail-form');
    const emptyState = document.getElementById('task-empty-state');
    if (form) {
        form.classList.add('hidden');
    }
    if (emptyState) {
        emptyState.classList.remove('hidden');
    }
}

async function handleTaskUpdateSubmit(event) {
    event.preventDefault();
    if (!selectedTask) {
        return;
    }
    const titleInput = document.getElementById('task-detail-title');
    const statusSelect = document.getElementById('task-detail-status');
    const priorityInput = document.getElementById('task-detail-priority');
    const statusText = document.getElementById('task-detail-status-text');

    const payload = {
        title: titleInput.value.trim(),
        status: statusSelect.value,
        priority: Number(priorityInput.value) || 5,
    };

    logUiEvent('task_update', { task_id: selectedTask, status: payload.status });

    try {
        const response = await fetch(`/api/tasks/${selectedTask}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
        const task = await response.json();
        if (!response.ok) {
            throw new Error(task.detail || 'Failed to update task');
        }
        populateTaskDetailForm(task);
        await loadTasksList();
    } catch (error) {
        console.error('Error updating task:', error);
        if (statusText) {
            statusText.textContent = error.message;
        }
    }
}

async function handleTaskDelete() {
    if (!selectedTask) {
        return;
    }
    if (!confirm('Delete this task?')) {
        return;
    }
    logUiEvent('task_delete', { task_id: selectedTask });
    try {
        const response = await fetch(`/api/tasks/${selectedTask}`, { method: 'DELETE' });
        if (!response.ok) {
            const result = await response.json().catch(() => ({}));
            throw new Error(result.detail || 'Failed to delete task');
        }
        resetTaskDetailPanel();
        await loadTasksList();
    } catch (error) {
        console.error('Error deleting task:', error);
        alert('Failed to delete task: ' + error.message);
    }
}

function handleAddSubtask() {
    if (!selectedTask || !selectedTaskDetails) {
        alert('Select a task first.');
        return;
    }
    logUiEvent('task_subtask_modal_open', { task_id: selectedTask });
    showTaskCreatePanel({
        mode: 'subtask',
        parentTaskId: selectedTask,
        projectId: selectedTaskDetails.project_id || selectedProject || '',
        priority: selectedTaskDetails.priority || 5,
        status: 'todo',
    });
}

function formatDate(value) {
    if (!value) return '—';
    try {
        return new Date(value).toLocaleString();
    } catch (error) {
        return value;
    }
}

function handleTrackingFetchError(message) {
    const now = Date.now();
    if (now - lastTrackingErrorAt > TRACKING_ERROR_COOLDOWN_MS) {
        logUiEvent('project_tracking_fetch_error', { message });
        lastTrackingErrorAt = now;
    }
    setTrackingError('Orchestrator unreachable. Please ensure the orchestrator service is running.');
}

function setTrackingError(message) {
    trackingErrorMessage = message || '';
    const errorEl = document.getElementById('project-tracking-error');
    if (errorEl) {
        if (trackingErrorMessage) {
            errorEl.textContent = trackingErrorMessage;
            errorEl.classList.remove('hidden');
        } else {
            errorEl.textContent = '';
            errorEl.classList.add('hidden');
        }
    }
    const configureBtn = document.getElementById('project-track-btn');
    const embedBtn = document.getElementById('project-embed-btn');
    const untrackBtn = document.getElementById('project-untrack-btn');
    [configureBtn, embedBtn, untrackBtn].forEach(btn => {
        if (btn) {
            btn.disabled = !!trackingErrorMessage;
        }
    });
    renderProjectTrackingBanner();
}

function clearTrackingError() {
    if (!trackingErrorMessage) {
        return;
    }
    trackingErrorMessage = '';
    const errorEl = document.getElementById('project-tracking-error');
    if (errorEl) {
        errorEl.textContent = '';
        errorEl.classList.add('hidden');
    }
    const configureBtn = document.getElementById('project-track-btn');
    const embedBtn = document.getElementById('project-embed-btn');
    const untrackBtn = document.getElementById('project-untrack-btn');
    [configureBtn, embedBtn, untrackBtn].forEach(btn => {
        if (btn) {
            btn.disabled = false;
        }
    });
    renderProjectTrackingBanner();
}

async function handleProjectDelete() {
    if (!selectedProject) {
        alert('Select a project first.');
        return;
    }
    const project = projectsCache.find(p => p.id === selectedProject);
    const requiredName = project ? project.name : 'this project';
    const confirmation = prompt(`Type "${requiredName}" to confirm deletion:`);
    if (!confirmation || confirmation.trim() !== requiredName) {
        alert('Project name did not match. Aborting delete.');
        return;
    }
    logUiEvent('project_delete', { project_id: selectedProject });
    try {
        const response = await fetch(`/api/projects/${selectedProject}`, { method: 'DELETE' });
        if (!response.ok) {
            const result = await response.json().catch(() => ({}));
            throw new Error(result.detail || 'Failed to delete project');
        }
        setActiveProject(null);
        selectedTask = null;
        hideTrackingConfigPanel();
        await loadProjects();
        await loadTasksList(null);
        resetTaskDetailPanel();
    } catch (error) {
        console.error('Error deleting project:', error);
        alert('Failed to delete project: ' + error.message);
    }
}

function projectStatusClass(projectId) {
    const info = projectTracking[projectId];
    if (!info || !info.is_tracked) {
        return 'project-untracked';
    }
    const status = info.embedding_status || 'pending';
    if (status === 'ready') {
        return 'project-tracked';
    }
    if (status === 'indexing' || status === 'pending') {
        return 'project-pending';
    }
    if (status === 'error') {
        return 'project-error';
    }
    return 'project-untracked';
}

function renderProjectBadges(projectId) {
    const info = projectTracking[projectId];
    if (!info) {
        return '';
    }
    const badges = [];
    if (info.global_embedding_status === 'ready') {
        badges.push('<span class="badge global">Global</span>');
    }
    if (info.embedding_mode) {
        badges.push(`<span class="badge mode">${info.embedding_mode.toUpperCase()}</span>`);
    }
    if (info.global_embedding_mode) {
        badges.push(`<span class="badge mode">G:${info.global_embedding_mode.toUpperCase()}</span>`);
    }
    if (!badges.length) {
        return '';
    }
    return `<div class="project-badges">${badges.join('')}</div>`;
}

function renderProjectTrackingBanner() {
    const banner = document.getElementById('project-tracking-banner');
    if (!banner) return;

    const statusText = document.getElementById('project-tracking-status');
    const detailEl = document.getElementById('project-tracking-details');
    const untrackBtn = document.getElementById('project-untrack-btn');
    const embedBtn = document.getElementById('project-embed-btn');
    const upgradeBtn = document.getElementById('project-upgrade-global-btn');
    const configureBtn = document.getElementById('project-track-btn');
    const deleteBtn = document.getElementById('project-delete-btn');
    const errorEl = document.getElementById('project-tracking-error');

    if (!selectedProject) {
        banner.classList.add('hidden');
        return;
    }

    const info = projectTracking[selectedProject];
    if (!info || !info.is_tracked) {
        banner.classList.remove('tracked', 'pending');
        banner.classList.add('untracked');
        statusText.textContent = 'Project not tracked';
        detailEl.textContent = 'Click "Configure Tracking" to assign a repo path and embedding model.';
        banner.classList.remove('hidden');
        if (untrackBtn) {
            untrackBtn.classList.add('hidden');
        }
        if (embedBtn) {
            embedBtn.disabled = true;
        }
        if (upgradeBtn) {
            upgradeBtn.classList.add('hidden');
            upgradeBtn.disabled = true;
        }
        if (configureBtn) {
            configureBtn.disabled = !!trackingErrorMessage;
        }
        if (deleteBtn) {
            deleteBtn.disabled = false;
        }
        if (errorEl) {
            if (trackingErrorMessage) {
                errorEl.textContent = trackingErrorMessage;
                errorEl.classList.remove('hidden');
            } else {
                errorEl.textContent = '';
                errorEl.classList.add('hidden');
            }
        }
        return;
    }

    const paths = Array.isArray(info.repo_paths) ? info.repo_paths : [];
    const repo = paths.length === 0
        ? (info.repo_path || 'Not set')
        : paths.length === 1
            ? paths[0]
            : `${paths[0]} (+${paths.length - 1} more)`;
    const statusLabel = info.embedding_status ? info.embedding_status.toUpperCase() : 'PENDING';
    const lastIndexed = info.embedding_last_indexed
        ? new Date(info.embedding_last_indexed).toLocaleString()
        : 'Never';
    const lastIndexedAge = formatTimeSince(info.embedding_last_indexed);
    const modelLabel = info.embedding_model_id || info.preferred_model_id || 'Default';
    const gpuLabel = info.gpu_enabled ? `GPU (${info.gpu_device || 'local'})` : 'CPU';
    const globalStatus = info.global_embedding_status ? info.global_embedding_status.toUpperCase() : 'NOT_TRACKED';
    const globalMode = info.global_embedding_mode ? info.global_embedding_mode.toUpperCase() : 'AUTO';
    const globalLastIndexed = info.global_embedding_last_indexed
        ? new Date(info.global_embedding_last_indexed).toLocaleString()
        : 'Never';
    const globalLastIndexedAge = formatTimeSince(info.global_embedding_last_indexed);

    if (info.embedding_status === 'ready') {
        banner.classList.add('tracked');
        banner.classList.remove('pending', 'untracked');
    } else if (info.embedding_status === 'indexing' || info.embedding_status === 'pending') {
        banner.classList.add('pending');
        banner.classList.remove('tracked', 'untracked');
    } else {
        banner.classList.remove('tracked', 'pending');
        banner.classList.add('untracked');
    }

    statusText.textContent = `${statusLabel} – Repo: ${repo}`;
    const projectStats = formatEmbeddingStats(info.embedding_stats);
    const globalStats = formatEmbeddingStats(info.global_embedding_stats);
    detailEl.innerHTML = `
        Last indexed: ${lastIndexed} (${lastIndexedAge}) · Model: ${modelLabel} · ${gpuLabel}<br>
        Global: ${globalStatus} (${globalMode}) · Last global: ${globalLastIndexed} (${globalLastIndexedAge})<br>
        ${projectStats ? `Project stats: ${projectStats}` : 'Project stats: —'}<br>
        ${globalStats ? `Global stats: ${globalStats}` : 'Global stats: —'}
    `;
    banner.classList.remove('hidden');
    if (untrackBtn) {
        untrackBtn.classList.toggle('hidden', !info.is_tracked);
    }
    if (embedBtn) {
        embedBtn.disabled = false;
    }
    if (upgradeBtn) {
        const showUpgrade = info.embedding_status === 'ready' && info.global_embedding_status !== 'ready';
        upgradeBtn.classList.toggle('hidden', !showUpgrade);
        upgradeBtn.disabled = !showUpgrade;
    }
    if (configureBtn) {
        configureBtn.disabled = false;
    }
    if (deleteBtn) {
        deleteBtn.disabled = false;
    }
    if (errorEl) {
        if (trackingErrorMessage) {
            errorEl.textContent = trackingErrorMessage;
            errorEl.classList.remove('hidden');
        } else {
            errorEl.textContent = '';
            errorEl.classList.add('hidden');
        }
    }

    const disabledDueToError = !!trackingErrorMessage;
    [configureBtn, embedBtn, untrackBtn, upgradeBtn].forEach(btn => {
        if (btn) {
            btn.disabled = disabledDueToError;
        }
    });
}

function initializeTrackingForm() {
    const form = document.getElementById('tracking-config-form');
    const gpuToggle = document.getElementById('tracking-gpu-enabled');
    const closeBtn = document.getElementById('tracking-config-close');
    const cancelBtn = document.getElementById('tracking-config-cancel');
    if (form) {
        form.addEventListener('submit', handleTrackingFormSubmit);
    }
    if (gpuToggle) {
        gpuToggle.addEventListener('change', (event) => toggleGpuDeviceRow(event.target.checked));
    }
    if (closeBtn) {
        closeBtn.addEventListener('click', hideTrackingConfigPanel);
    }
    if (cancelBtn) {
        cancelBtn.addEventListener('click', hideTrackingConfigPanel);
    }
}

function initializeEmbeddingControls() {
    const modeSelect = document.getElementById('project-embed-mode');
    const descEl = document.getElementById('project-embed-mode-desc');
    if (modeSelect) {
        modeSelect.addEventListener('change', () => setEmbeddingModeDescription(modeSelect, descEl));
        setEmbeddingModeDescription(modeSelect, descEl);
    }
}

function initializeEmbeddingsView() {
    const form = document.getElementById('global-embed-form');
    if (form) {
        form.addEventListener('submit', handleGlobalEmbeddingSubmit);
    }
    const modeSelect = document.getElementById('global-embed-mode');
    const descEl = document.getElementById('global-embed-mode-desc');
    if (modeSelect) {
        modeSelect.addEventListener('change', () => setEmbeddingModeDescription(modeSelect, descEl));
        setEmbeddingModeDescription(modeSelect, descEl);
    }
    const searchBtn = document.getElementById('global-search-btn');
    if (searchBtn) {
        searchBtn.addEventListener('click', handleGlobalSearch);
    }
}

function showTrackingConfigPanel() {
    if (!selectedProject) {
        alert('Select a project first.');
        return;
    }
    if (trackingErrorMessage) {
        alert('Cannot configure tracking while the orchestrator is unreachable.');
        return;
    }
    const panel = document.getElementById('tracking-config-panel');
    const titleEl = document.getElementById('tracking-config-project');
    const repoInput = document.getElementById('tracking-repo-path');
    const modelSelect = document.getElementById('tracking-preferred-model');
    const gpuToggle = document.getElementById('tracking-gpu-enabled');
    const gpuDevice = document.getElementById('tracking-gpu-device');
    const info = projectTracking[selectedProject] || {};
    const project = projectsCache.find(p => p.id === selectedProject);

    if (panel && repoInput && modelSelect && gpuToggle && gpuDevice) {
        if (titleEl && project) {
            titleEl.textContent = project.name;
        }
        const repoPaths = Array.isArray(info.repo_paths) && info.repo_paths.length > 0
            ? info.repo_paths.join('\n')
            : (info.repo_path || '');
        repoInput.value = repoPaths;
        populateTrackingModelSelect(modelSelect, info.preferred_model_id || info.embedding_model_id || '');
        gpuToggle.checked = !!info.gpu_enabled;
        gpuDevice.value = info.gpu_device || '';
        toggleGpuDeviceRow(gpuToggle.checked);
        panel.classList.remove('hidden');
        repoInput.focus();
    }
}

function hideTrackingConfigPanel() {
    const panel = document.getElementById('tracking-config-panel');
    const status = document.getElementById('tracking-config-status');
    if (panel) {
        panel.classList.add('hidden');
    }
    if (status) {
        status.textContent = '';
    }
}

function populateTrackingModelSelect(select, selectedValue = '') {
    if (!select) return;
    const options = availableModels.length
        ? availableModels.map(model => `<option value="${model.id}">${model.label}</option>`).join('')
        : '<option value="">Default (server)</option>';
    select.innerHTML = `<option value="">Auto (server default)</option>${options}`;
    select.value = selectedValue || '';
}

function toggleGpuDeviceRow(show) {
    const row = document.getElementById('tracking-gpu-device-row');
    if (row) {
        row.classList.toggle('hidden', !show);
    }
}

async function handleTrackingFormSubmit(event) {
    event.preventDefault();
    if (!selectedProject) {
        alert('Select a project first.');
        return;
    }
    if (trackingErrorMessage) {
        alert('Cannot update tracking while the orchestrator is unreachable.');
        return;
    }

    const repoInput = document.getElementById('tracking-repo-path');
    const modelSelect = document.getElementById('tracking-preferred-model');
    const gpuToggle = document.getElementById('tracking-gpu-enabled');
    const gpuDevice = document.getElementById('tracking-gpu-device');
    const status = document.getElementById('tracking-config-status');

    if (!repoInput) {
        return;
    }

    const repoPaths = repoInput.value
        .split('\n')
        .map(line => line.trim())
        .filter(Boolean);
    if (repoPaths.length === 0) {
        status.textContent = 'At least one repository path is required.';
        return;
    }
    const repoPath = repoPaths[0];

    const payload = {
        repo_path: repoPath,
        repo_paths: repoPaths,
        is_tracked: true,
        preferred_model_id: modelSelect && modelSelect.value ? modelSelect.value : undefined,
        gpu_enabled: gpuToggle ? gpuToggle.checked : false,
        gpu_device: gpuDevice && gpuDevice.value ? gpuDevice.value.trim() : undefined,
    };

    logUiEvent('project_tracking_configure', {
        project_id: selectedProject,
        repo_path: repoPath,
        preferred_model_id: payload.preferred_model_id || null,
        gpu_enabled: payload.gpu_enabled,
    });

    try {
        const response = await fetch(`/api/project-tracking/${selectedProject}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
        if (!response.ok) {
            const result = await response.json().catch(() => ({}));
            throw new Error(result.detail || 'Failed to update tracking');
        }
        if (status) {
            status.textContent = 'Tracking updated';
        }
        await loadProjects();
        await refreshProjectTracking(selectedProject);
        hideTrackingConfigPanel();
    } catch (error) {
        console.error('Error updating tracking:', error);
        if (status) {
            status.textContent = error.message;
        }
        handleTrackingFetchError(error.message || 'unknown');
    }
}

async function stopProjectTracking() {
    if (!selectedProject) return;
    if (trackingErrorMessage) {
        alert('Cannot update tracking while the orchestrator is unreachable.');
        return;
    }
    if (!confirm('Stop tracking this project?')) {
        return;
    }
    logUiEvent('project_tracking_disable', { project_id: selectedProject });
    try {
        await fetch(`/api/project-tracking/${selectedProject}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ is_tracked: false }),
        });
        await loadProjects();
        await refreshProjectTracking(selectedProject);
    } catch (error) {
        console.error('Error disabling tracking:', error);
        alert('Failed to stop tracking: ' + error.message);
        handleTrackingFetchError(error.message || 'unknown');
    }
}

async function startEmbeddingRun() {
    if (!selectedProject) {
        alert('Select a project first.');
        return;
    }
    if (trackingErrorMessage) {
        alert('Cannot start embeddings while the orchestrator is unreachable.');
        return;
    }
    const info = projectTracking[selectedProject];
    if (!info || !info.is_tracked) {
        alert('Configure tracking before starting an embedding run.');
        return;
    }

    const modeSelect = document.getElementById('project-embed-mode');
    const globalToggle = document.getElementById('project-embed-global');
    const mode = modeSelect ? modeSelect.value : 'auto';
    const target = globalToggle && globalToggle.checked ? 'both' : 'project';

    logUiEvent('project_embedding_start', { project_id: selectedProject, mode, target });
    try {
        const response = await fetch(`/api/project-tracking/${selectedProject}/index`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mode, target, ...approvalMetadata('webui-project-embed') }),
        });
        const result = await response.json();
        if (!response.ok) {
            throw new Error(result.detail || 'Unable to start embedding');
        }
        await refreshProjectTracking(selectedProject);
        alert(`Embedding job queued: ${result.task_id || 'pending'}`);
    } catch (error) {
        console.error('Error queuing embedding run:', error);
        alert('Failed to start embedding: ' + error.message);
        handleTrackingFetchError(error.message || 'unknown');
    }
}

async function upgradeProjectToGlobal() {
    if (!selectedProject) {
        alert('Select a project first.');
        return;
    }
    const modeSelect = document.getElementById('project-embed-mode');
    const mode = modeSelect ? modeSelect.value : 'auto';
    logUiEvent('project_embedding_upgrade_global', { project_id: selectedProject, mode });
    try {
        const response = await fetch(`/api/project-tracking/${selectedProject}/index`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mode, target: 'global', ...approvalMetadata('webui-project-global-upgrade') }),
        });
        const result = await response.json();
        if (!response.ok) {
            throw new Error(result.detail || 'Unable to upgrade to global');
        }
        await refreshProjectTracking(selectedProject);
        alert(`Global embedding job queued: ${result.task_id || 'pending'}`);
    } catch (error) {
        console.error('Error queuing global embedding:', error);
        alert('Failed to upgrade to global: ' + error.message);
        handleTrackingFetchError(error.message || 'unknown');
    }
}

async function refreshProjectTracking(projectId) {
    try {
        const info = await fetch(`/api/project-tracking/${projectId}`).then(r => r.json());
        projectTracking[projectId] = info;
        clearTrackingError();
        renderProjectTrackingBanner();
    } catch (error) {
        console.error('Error refreshing tracking info:', error);
        handleTrackingFetchError(error.message || 'unknown');
    }
}

async function createNewProject() {
    const nameInput = prompt('Project name? (required)');
    if (nameInput === null) {
        return;
    }
    const name = nameInput.trim();
    if (!name) {
        alert('Project name is required.');
        return;
    }

    const statusInput = prompt('Project status (active/backlog/completed)', 'active') || 'active';
    const status = statusInput.trim() || 'active';

    const track = confirm('Track this project and prepare embeddings?');
    let repoPath = '';
    if (track) {
        const repoPrompt = prompt('Repository path (required for tracking):', '');
        if (repoPrompt === null) {
            return;
        }
        repoPath = (repoPrompt || '').trim();
        if (!repoPath) {
            alert('Repository path is required when tracking.');
            return;
        }
    } else {
        const maybeRepo = prompt('Repository path (optional):', '');
        if (maybeRepo !== null) {
            repoPath = (maybeRepo || '').trim();
        }
    }

    const payload = {
        name,
        status,
        track,
        repo_path: repoPath || undefined,
    };

    logUiEvent('project_create', {
        name,
        status,
        track,
        repo_path: repoPath || null,
    });
    try {
        const response = await fetch('/api/projects', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
        const project = await response.json();
        if (!response.ok) {
            throw new Error(project.detail || 'Failed to create project');
        }
        setActiveProject(project.id);
        await loadProjects();
        await loadTasksList(project.id);
        await refreshProjectTracking(project.id);
    } catch (error) {
        console.error('Error creating project:', error);
        alert('Failed to create project: ' + error.message);
    }
}

// Memory View
async function loadMemoryView() {
    await loadMemoryStats();
    if (memorySemanticActive && memorySemanticResults.length) {
        renderMemoryItems(memorySemanticResults);
        return;
    }
    await loadMemoryItems();
}

// Embeddings View
async function loadEmbeddingsView() {
    await loadGlobalEmbeddingStats();
    await loadAstProgress();
    if (!astProgressTimer) {
        astProgressTimer = setInterval(loadAstProgress, 5000);
    }
}

// System Stats View
async function loadSystemStats() {
    await Promise.all([loadDockerStats(), loadDbStats(), loadLmstudioStats()]);
}

async function loadDatabaseView() {
    const statusEl = document.getElementById('db-query-status');
    if (statusEl) {
        statusEl.textContent = 'Loading...';
    }
    try {
        const response = await fetch('/api/system/db-queries');
        const payload = await response.json();
        if (!response.ok) {
            throw new Error(payload.detail || 'Failed to load database queries');
        }
        renderDbProjects(payload.projects || []);
        renderDbTasks(payload.tasks || []);
        renderDbMemories(payload.memories || []);
        renderDbCodeChunks(payload.code_chunks || []);
        if (statusEl) {
            statusEl.textContent = `Updated ${new Date().toLocaleTimeString()}`;
        }
    } catch (error) {
        console.error('Error loading database view:', error);
        if (statusEl) {
            statusEl.textContent = `Error: ${error.message}`;
        }
    }
}

function switchDbView(viewKey) {
    const buttons = document.querySelectorAll('.subnav-btn');
    const views = document.querySelectorAll('.db-view');
    buttons.forEach((button) => {
        button.classList.toggle('active', button.dataset.dbView === viewKey);
    });
    views.forEach((view) => {
        view.classList.toggle('active', view.dataset.dbView === viewKey);
    });
    if (viewKey === 'schema') {
        loadDbSchema();
    }
    if (viewKey === 'trends') {
        loadDbTrends();
    }
}

function switchSystemView(viewKey, initial = false) {
    currentSystemView = viewKey || 'stats';
    const buttons = document.querySelectorAll('.subnav-btn[data-system-view]');
    const views = document.querySelectorAll('.system-view');
    buttons.forEach((button) => {
        button.classList.toggle('active', button.dataset.systemView === currentSystemView);
    });
    views.forEach((view) => {
        view.classList.toggle('active', view.dataset.systemView === currentSystemView);
    });
    if (!initial) {
        logUiEvent('system_view_switch', { view: currentSystemView });
    }
    switch (currentSystemView) {
        case 'stats':
            loadSystemStats();
            break;
        case 'database':
            loadDatabaseView();
            switchDbView('queries');
            break;
        case 'lmstudio':
            loadLmstudioView();
            break;
        case 'logs':
            loadLogsView();
            break;
        default:
            loadSystemStats();
            break;
    }
}

function startSystemMeter() {
    const update = async () => {
        const cpuEl = document.getElementById('meter-cpu');
        const ramEl = document.getElementById('meter-ram');
        const gpuEl = document.getElementById('meter-gpu');
        if (!cpuEl || !ramEl || !gpuEl) return;
        try {
            const response = await fetch('/api/system/telemetry');
            const payload = await response.json();
            if (!response.ok) {
                throw new Error(payload.detail || 'Telemetry failed');
            }
            cpuEl.textContent = payload.cpu_percent !== null ? `${payload.cpu_percent.toFixed(0)}%` : '—';
            if (payload.mem_total_mb) {
                ramEl.textContent = `${payload.mem_used_mb}/${payload.mem_total_mb} MB`;
            } else {
                ramEl.textContent = '—';
            }
            if (payload.gpu && payload.gpu.length) {
                const gpu = payload.gpu[0];
                const util = gpu.utilization !== null ? `${gpu.utilization}%` : '—';
                const mem = gpu.mem_total_mb ? `${gpu.mem_used_mb}/${gpu.mem_total_mb} MB` : '';
                gpuEl.textContent = mem ? `${util} (${mem})` : util;
            } else {
                gpuEl.textContent = '—';
            }
        } catch (error) {
            cpuEl.textContent = '—';
            ramEl.textContent = '—';
            gpuEl.textContent = '—';
        }
    };
    update();
    setInterval(update, 5000);
}

async function loadDbSchema() {
    const statusEl = document.getElementById('db-schema-status');
    if (statusEl) statusEl.textContent = 'Loading...';
    try {
        const response = await fetch('/api/system/db-schema');
        const payload = await response.json();
        if (!response.ok) {
            throw new Error(payload.detail || 'Schema failed');
        }
        dbSchemaCache = payload;
        renderDbSchema(payload);
        if (statusEl) statusEl.textContent = `Updated ${new Date().toLocaleTimeString()}`;
    } catch (error) {
        if (statusEl) statusEl.textContent = `Error: ${error.message}`;
    }
}

function renderDbSchema(payload) {
    const graph = document.getElementById('db-schema-graph');
    const legend = document.getElementById('db-schema-legend');
    if (!graph || !payload) return;
    const dbSelect = document.getElementById('db-schema-database');
    const scope = dbSelect ? dbSelect.value : 'core';
    const tables = (payload.tables || []).filter((table) => table.group === scope);
    const edges = (payload.edges || []).filter((edge) => edge.group === scope);

    const width = 900;
    const height = 520;
    const centerX = width / 2;
    const centerY = height / 2;
    const radius = Math.min(centerX, centerY) - 90;
    const angleStep = tables.length ? (Math.PI * 2) / tables.length : 0;

    const positioned = tables.map((table, index) => {
        const angle = index * angleStep - Math.PI / 2;
        const x = centerX + radius * Math.cos(angle);
        const y = centerY + radius * Math.sin(angle);
        return { ...table, x, y };
    });

    const nodeByName = {};
    positioned.forEach((table) => {
        nodeByName[table.name] = table;
    });

    const edgeSvg = edges.map((edge) => {
        const source = nodeByName[edge.from];
        const target = nodeByName[edge.to];
        if (!source || !target) return '';
        return `<line x1="${source.x}" y1="${source.y}" x2="${target.x}" y2="${target.y}" class="schema-edge"/>`;
    }).join('');

    const nodeSvg = positioned.map((table) => `
        <g class="schema-node">
            <circle cx="${table.x}" cy="${table.y}" r="48"></circle>
            <text x="${table.x}" y="${table.y - 6}" text-anchor="middle">${table.label}</text>
            <text x="${table.x}" y="${table.y + 14}" text-anchor="middle" class="schema-sub">${table.name}</text>
        </g>
    `).join('');

    graph.innerHTML = `
        <rect width="100%" height="100%" rx="24" ry="24" class="schema-bg"></rect>
        ${edgeSvg}
        ${nodeSvg}
    `;

    if (legend) {
        legend.innerHTML = (payload.groups || [])
            .map((group) => `<span class="legend-pill">${group.label}</span>`)
            .join('');
    }
}

async function loadDbTrends() {
    const statusEl = document.getElementById('db-trends-status');
    if (statusEl) statusEl.textContent = 'Loading...';
    try {
        const response = await fetch('/api/system/db-trends');
        const payload = await response.json();
        if (!response.ok) {
            throw new Error(payload.detail || 'Trends failed');
        }
        dbTrendsCache = payload;
        renderDbTrends(payload);
        if (statusEl) statusEl.textContent = `Updated ${new Date().toLocaleTimeString()}`;
    } catch (error) {
        if (statusEl) statusEl.textContent = `Error: ${error.message}`;
    }
}

function renderDbTrends(payload) {
    const container = document.getElementById('db-trends-projects');
    if (!container || !payload) return;
    const projects = payload.projects || [];
    container.innerHTML = projects.map((project) => `
        <label class="checkbox-inline">
            <input type="checkbox" class="db-trends-project" data-project-id="${project.id}" checked>
            ${project.name}
        </label>
    `).join('');
    container.querySelectorAll('.db-trends-project').forEach((input) => {
        input.addEventListener('change', () => renderDbTrendsChart(payload));
    });
    renderDbTrendsChart(payload);
}

function setDbTrendsSelection(selectAll) {
    document.querySelectorAll('.db-trends-project').forEach((input) => {
        input.checked = selectAll;
    });
    renderDbTrendsChart(dbTrendsCache);
}

function renderDbTrendsChart(payload) {
    const canvas = document.getElementById('db-trends-canvas');
    if (!canvas || !payload) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const selectedIds = Array.from(document.querySelectorAll('.db-trends-project'))
        .filter((input) => input.checked)
        .map((input) => input.dataset.projectId);
    const projects = (payload.projects || []).filter((project) => selectedIds.includes(project.id));
    if (!projects.length) {
        ctx.fillStyle = '#94a3b8';
        ctx.fillText('Select at least one project to view trends.', 20, 30);
        return;
    }

    const metrics = ['tasks', 'memories', 'code_chunks'];
    const colors = ['#3b82f6', '#10b981', '#f59e0b'];
    const maxValue = Math.max(
        ...projects.map((project) => Math.max(project.tasks, project.memories, project.code_chunks)),
        1
    );
    const padding = 40;
    const chartWidth = canvas.width - padding * 2;
    const chartHeight = canvas.height - padding * 2;
    const groupWidth = chartWidth / projects.length;
    const barWidth = Math.min(34, (groupWidth - 16) / metrics.length);

    ctx.font = '12px system-ui, sans-serif';
    ctx.fillStyle = '#cbd5e1';
    ctx.fillText('Project counts', padding, padding - 12);

    projects.forEach((project, index) => {
        const baseX = padding + index * groupWidth + 8;
        metrics.forEach((metric, metricIndex) => {
            const value = project[metric] || 0;
            const barHeight = (value / maxValue) * chartHeight;
            ctx.fillStyle = colors[metricIndex];
            ctx.fillRect(baseX + metricIndex * (barWidth + 6), padding + (chartHeight - barHeight), barWidth, barHeight);
        });
        ctx.fillStyle = '#e2e8f0';
        ctx.fillText(project.name.slice(0, 10), baseX, padding + chartHeight + 18);
    });

    metrics.forEach((metric, index) => {
        ctx.fillStyle = colors[index];
        ctx.fillRect(padding + index * 110, canvas.height - 18, 12, 12);
        ctx.fillStyle = '#e2e8f0';
        ctx.fillText(metric.replace('_', ' '), padding + index * 110 + 18, canvas.height - 8);
    });
}

// LM Studio View
async function loadLmstudioView() {
    const statusEl = document.getElementById('lmstudio-page-status');
    if (statusEl) {
        statusEl.textContent = 'Loading...';
    }
    await Promise.all([loadLmstudioStatus(), loadLmstudioModels(), loadLmstudioLoaded()]);
    if (statusEl) {
        statusEl.textContent = `Updated ${new Date().toLocaleTimeString()}`;
    }
}

async function loadLmstudioStatus() {
    const statusEl = document.getElementById('lmstudio-server-status');
    try {
        const response = await fetch('/api/lmstudio/status');
        const payload = await response.json();
        if (!response.ok) {
            throw new Error(payload.detail || 'Status failed');
        }
        const text = payload.stdout || payload.detail || 'unknown';
        if (statusEl) {
            statusEl.textContent = text.includes('ON') ? 'online' : text || 'unknown';
        }
    } catch (error) {
        if (statusEl) {
            statusEl.textContent = 'offline';
        }
    }
}

async function loadLmstudioModels() {
    const listEl = document.getElementById('lmstudio-models-list');
    try {
        const response = await fetch('/api/lmstudio/models');
        const payload = await response.json();
        if (!response.ok) {
            throw new Error(payload.detail || 'Models failed');
        }
        const models = payload || [];
        const countEl = document.getElementById('lmstudio-available-count');
        if (countEl) {
            countEl.textContent = models.length;
        }
        renderLmstudioModels(listEl, models);
    } catch (error) {
        if (listEl) {
            listEl.innerHTML = '<div class="error">Failed to load models</div>';
        }
    }
}

async function loadLmstudioLoaded() {
    const listEl = document.getElementById('lmstudio-loaded-list');
    try {
        const response = await fetch('/api/lmstudio/loaded');
        const payload = await response.json();
        if (!response.ok) {
            throw new Error(payload.detail || 'Loaded models failed');
        }
        const models = payload || [];
        const countEl = document.getElementById('lmstudio-loaded-count');
        if (countEl) {
            countEl.textContent = models.length;
        }
        renderLmstudioLoaded(listEl, models);
    } catch (error) {
        if (listEl) {
            listEl.innerHTML = '<div class="error">Failed to load loaded models</div>';
        }
    }
}

function renderLmstudioModels(container, models) {
    if (!container) {
        return;
    }
    if (!models.length) {
        container.innerHTML = '<div class="empty-state">No models found</div>';
        return;
    }
    const rows = models.map((model) => {
        const display = model.displayName || model.name || model.model_name || model.modelKey || model.key || model.path || '—';
        const params = model.paramsString || model.params || '—';
        const quant = model.quantization?.name || model.quantization || '—';
        const context = model.maxContextLength || model.context_length || '—';
        const modelKey = model.modelKey || model.key || model.path || '—';
        return `
            <div class="data-row six-col">
                <div>${display}</div>
                <div>${model.type || model.category || '—'}</div>
                <div>${params}</div>
                <div>${quant}</div>
                <div>${context}</div>
                <div class="mono muted">${modelKey}</div>
            </div>
        `;
    }).join('');
    container.innerHTML = `
        <div class="data-row header six-col">
            <div>Name</div>
            <div>Type</div>
            <div>Params</div>
            <div>Quant</div>
            <div>Context</div>
            <div>Key</div>
        </div>
        ${rows}
    `;
}

function renderLmstudioLoaded(container, models) {
    if (!container) {
        return;
    }
    if (!models.length) {
        container.innerHTML = '<div class="empty-state">No loaded models</div>';
        return;
    }
    container.innerHTML = `
        <div class="data-row header four-col">
            <div>ID</div>
            <div>Model</div>
            <div>Context</div>
            <div>GPU</div>
        </div>
        ${models.map((model) => `
            <div class="data-row four-col">
                <div>${model.identifier || model.id || '—'}</div>
                <div>${model.model || model.name || model.modelKey || '—'}</div>
                <div>${model.context_length || model.ctx || '—'}</div>
                <div>${model.gpu || model.gpu_offload || '—'}</div>
            </div>
        `).join('')}
    `;
}

async function handleLmstudioLoad(event) {
    event.preventDefault();
    const statusEl = document.getElementById('lmstudio-load-status');
    const payload = {
        path: document.getElementById('lmstudio-load-path')?.value.trim(),
        identifier: document.getElementById('lmstudio-load-identifier')?.value.trim() || undefined,
        gpu: document.getElementById('lmstudio-load-gpu')?.value.trim() || undefined,
        context_length: Number(document.getElementById('lmstudio-load-ctx')?.value || 0) || undefined,
        ttl: Number(document.getElementById('lmstudio-load-ttl')?.value || 0) || undefined,
        exact: Boolean(document.getElementById('lmstudio-load-exact')?.checked),
        estimate_only: Boolean(document.getElementById('lmstudio-load-estimate')?.checked),
    };
    if (!payload.path) {
        if (statusEl) statusEl.textContent = 'Model path is required.';
        return;
    }
    if (statusEl) statusEl.textContent = 'Loading...';
    try {
        const response = await fetch('/api/lmstudio/load', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
        const result = await response.json();
        if (!response.ok) {
            throw new Error(result.detail?.detail || result.detail || 'Load failed');
        }
        if (statusEl) statusEl.textContent = 'Load complete.';
        await loadLmstudioLoaded();
    } catch (error) {
        if (statusEl) statusEl.textContent = `Load failed: ${error.message}`;
    }
}

async function handleLmstudioUnload(event) {
    event.preventDefault();
    const statusEl = document.getElementById('lmstudio-unload-status');
    const payload = {
        identifier: document.getElementById('lmstudio-unload-identifier')?.value.trim() || undefined,
        all: Boolean(document.getElementById('lmstudio-unload-all')?.checked),
    };
    if (!payload.identifier && !payload.all) {
        if (statusEl) statusEl.textContent = 'Provide an identifier or select unload all.';
        return;
    }
    if (statusEl) statusEl.textContent = 'Unloading...';
    try {
        const response = await fetch('/api/lmstudio/unload', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
        const result = await response.json();
        if (!response.ok) {
            throw new Error(result.detail?.detail || result.detail || 'Unload failed');
        }
        if (statusEl) statusEl.textContent = 'Unload complete.';
        await loadLmstudioLoaded();
    } catch (error) {
        if (statusEl) statusEl.textContent = `Unload failed: ${error.message}`;
    }
}

async function handleLmstudioGet(event) {
    event.preventDefault();
    const statusEl = document.getElementById('lmstudio-get-status');
    const payload = {
        model_name: document.getElementById('lmstudio-get-name')?.value.trim(),
        gguf: Boolean(document.getElementById('lmstudio-get-gguf')?.checked),
        mlx: Boolean(document.getElementById('lmstudio-get-mlx')?.checked),
        always_show_all: Boolean(document.getElementById('lmstudio-get-show-all')?.checked),
        always_show_download: Boolean(document.getElementById('lmstudio-get-show-download')?.checked),
        limit: Number(document.getElementById('lmstudio-get-limit')?.value || 0) || undefined,
    };
    if (!payload.model_name) {
        if (statusEl) statusEl.textContent = 'Model name is required.';
        return;
    }
    if (statusEl) statusEl.textContent = 'Downloading...';
    try {
        const response = await fetch('/api/lmstudio/get', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
        const result = await response.json();
        if (!response.ok) {
            throw new Error(result.detail?.detail || result.detail || 'Download failed');
        }
        if (statusEl) statusEl.textContent = 'Download command sent.';
        await loadLmstudioModels();
    } catch (error) {
        if (statusEl) statusEl.textContent = `Download failed: ${error.message}`;
    }
}

async function handleLmstudioServer(action) {
    const statusEl = document.getElementById('lmstudio-server-status-text');
    if (statusEl) statusEl.textContent = `${action}...`;
    try {
        const response = await fetch(`/api/lmstudio/server/${action}`, { method: 'POST' });
        const result = await response.json();
        if (!response.ok) {
            throw new Error(result.detail?.detail || result.detail || 'Server command failed');
        }
        if (statusEl) statusEl.textContent = `Server ${action} complete.`;
        await loadLmstudioStatus();
    } catch (error) {
        if (statusEl) statusEl.textContent = `Server ${action} failed: ${error.message}`;
    }
}

async function loadDockerStats() {
    const statusEl = document.getElementById('docker-status');
    const listEl = document.getElementById('docker-list');
    if (statusEl) {
        statusEl.textContent = 'Loading...';
    }
    try {
        const response = await fetch('/api/system/docker');
        const payload = await response.json();
        if (!response.ok) {
            throw new Error(payload.detail || 'Failed to load docker info');
        }
        const containers = payload.containers || [];
        const countEl = document.getElementById('stat-docker-containers');
        if (countEl) {
            countEl.textContent = containers.length;
        }
        renderDockerList(listEl, containers);
        if (statusEl) {
            statusEl.textContent = `Updated ${new Date().toLocaleTimeString()}`;
        }
    } catch (error) {
        console.error('Error loading docker stats:', error);
        if (statusEl) {
            statusEl.textContent = `Error: ${error.message}`;
        }
        if (listEl) {
            listEl.innerHTML = '<div class="error">Docker stats unavailable</div>';
        }
    }
}

async function loadDbStats() {
    const statusEl = document.getElementById('db-status');
    const listEl = document.getElementById('db-list');
    if (statusEl) {
        statusEl.textContent = 'Loading...';
    }
    try {
        const response = await fetch('/api/system/db');
        const payload = await response.json();
        if (!response.ok) {
            throw new Error(payload.detail || 'Failed to load database stats');
        }
        updateDbSummary(payload);
        renderDbList(listEl, payload);
        if (statusEl) {
            statusEl.textContent = `Updated ${new Date().toLocaleTimeString()}`;
        }
    } catch (error) {
        console.error('Error loading db stats:', error);
        if (statusEl) {
            statusEl.textContent = `Error: ${error.message}`;
        }
        if (listEl) {
            listEl.innerHTML = '<div class="error">Database stats unavailable</div>';
        }
    }
}

async function loadLmstudioStats() {
    const statusEl = document.getElementById('lmstudio-status');
    const listEl = document.getElementById('lmstudio-list');
    if (statusEl) {
        statusEl.textContent = 'Loading...';
    }
    try {
        const response = await fetch('/api/system/lmstudio');
        const payload = await response.json();
        if (!response.ok) {
            throw new Error(payload.detail || 'Failed to load LM Studio');
        }
        const statusElCard = document.getElementById('stat-lmstudio-status');
        if (statusElCard) {
            statusElCard.textContent = payload.server || 'unknown';
        }
        renderLmstudioList(listEl, payload);
        if (statusEl) {
            statusEl.textContent = `Updated ${new Date().toLocaleTimeString()}`;
        }
    } catch (error) {
        console.error('Error loading LM Studio status:', error);
        const statusElCard = document.getElementById('stat-lmstudio-status');
        if (statusElCard) {
            statusElCard.textContent = 'offline';
        }
        if (statusEl) {
            statusEl.textContent = `Error: ${error.message}`;
        }
        if (listEl) {
            listEl.innerHTML = '<div class="error">LM Studio unavailable</div>';
        }
    }
}

function renderDockerList(container, items) {
    if (!container) {
        return;
    }
    if (!items.length) {
        container.innerHTML = '<div class="empty-state">No containers found</div>';
        return;
    }
    container.innerHTML = `
        <div class="data-row header">
            <div>Name</div>
            <div>Status</div>
            <div>Image</div>
            <div>Ports</div>
            <div>Memory</div>
        </div>
        ${items.map((item) => {
            const ports = (item.ports || []).join(', ') || '—';
            const mem = formatMemory(item.mem_usage_bytes, item.mem_limit_bytes);
            return `
                <div class="data-row">
                    <div>${item.name}</div>
                    <div>${item.status}</div>
                    <div>${item.image}</div>
                    <div>${ports}</div>
                    <div>${mem}</div>
                </div>
            `;
        }).join('')}
    `;
}

function renderDbList(container, payload) {
    if (!container) {
        return;
    }
    container.innerHTML = `
        <div class="data-row header two-col">
            <div>Metric</div>
            <div>Value</div>
        </div>
        <div class="data-row two-col"><div>Projects</div><div>${payload.projects}</div></div>
        <div class="data-row two-col"><div>Tasks</div><div>${payload.tasks}</div></div>
        <div class="data-row two-col"><div>Task Links</div><div>${payload.task_links}</div></div>
        <div class="data-row two-col"><div>Memory Items</div><div>${payload.memory_items}</div></div>
        <div class="data-row two-col"><div>Code Chunks</div><div>${payload.code_chunks}</div></div>
        <div class="data-row two-col"><div>Project Tracking</div><div>${payload.project_tracking}</div></div>
        <div class="data-row two-col"><div>DB Size</div><div>${formatBytes(payload.db_size_bytes)}</div></div>
        <div class="data-row two-col"><div>DB Version</div><div>${payload.db_version || '—'}</div></div>
    `;
}

function renderLmstudioList(container, payload) {
    if (!container) {
        return;
    }
    const models = payload.models || [];
    if (!models.length) {
        container.innerHTML = '<div class="empty-state">No models reported</div>';
        return;
    }
    container.innerHTML = `
        <div class="data-row header three-col">
            <div>ID</div>
            <div>Owned By</div>
            <div>Object</div>
        </div>
        ${models.map((model) => `
            <div class="data-row three-col">
                <div>${model.id || '—'}</div>
                <div>${model.owned_by || '—'}</div>
                <div>${model.object || '—'}</div>
            </div>
        `).join('')}
    `;
}

function renderDbProjects(items) {
    const container = document.getElementById('db-projects-list');
    if (!container) {
        return;
    }
    if (!items.length) {
        container.innerHTML = '<div class="empty-state">No projects found</div>';
        return;
    }
    container.innerHTML = `
        <div class="data-row header three-col">
            <div>Name</div>
            <div>Status</div>
            <div>Created</div>
        </div>
        ${items.map((item) => `
            <div class="data-row three-col">
                <div>${item.name}</div>
                <div>${item.status}</div>
                <div>${new Date(item.created_at).toLocaleString()}</div>
            </div>
        `).join('')}
    `;
}

function renderDbTasks(items) {
    const container = document.getElementById('db-tasks-list');
    if (!container) {
        return;
    }
    if (!items.length) {
        container.innerHTML = '<div class="empty-state">No tasks found</div>';
        return;
    }
    container.innerHTML = `
        <div class="data-row header three-col">
            <div>Title</div>
            <div>Status</div>
            <div>Created</div>
        </div>
        ${items.map((item) => `
            <div class="data-row three-col">
                <div>${item.title}</div>
                <div>${item.status}</div>
                <div>${new Date(item.created_at).toLocaleString()}</div>
            </div>
        `).join('')}
    `;
}

function renderDbMemories(items) {
    const container = document.getElementById('db-memories-list');
    if (!container) {
        return;
    }
    if (!items.length) {
        container.innerHTML = '<div class="empty-state">No memories found</div>';
        return;
    }
    container.innerHTML = `
        <div class="data-row header three-col">
            <div>ID</div>
            <div>Created By</div>
            <div>Created</div>
        </div>
        ${items.map((item) => `
            <div class="data-row three-col">
                <div>${String(item.memory_id).slice(0, 8)}…</div>
                <div>${item.created_by}</div>
                <div>${new Date(item.created_at).toLocaleString()}</div>
            </div>
        `).join('')}
    `;
}

function renderDbCodeChunks(items) {
    const container = document.getElementById('db-code-list');
    if (!container) {
        return;
    }
    if (!items.length) {
        container.innerHTML = '<div class="empty-state">No code chunks found</div>';
        return;
    }
    container.innerHTML = `
        <div class="data-row header three-col">
            <div>File</div>
            <div>Symbol</div>
            <div>Updated</div>
        </div>
        ${items.map((item) => `
            <div class="data-row three-col">
                <div>${item.file_path}</div>
                <div>${item.symbol_name}</div>
                <div>${new Date(item.updated_at).toLocaleString()}</div>
            </div>
        `).join('')}
    `;
}

function updateDbSummary(payload) {
    const projectsEl = document.getElementById('stat-db-projects');
    const tasksEl = document.getElementById('stat-db-tasks');
    const memoryEl = document.getElementById('stat-db-memory');
    if (projectsEl) {
        projectsEl.textContent = payload.projects ?? 0;
    }
    if (tasksEl) {
        tasksEl.textContent = payload.tasks ?? 0;
    }
    if (memoryEl) {
        memoryEl.textContent = payload.memory_items ?? 0;
    }
}

function formatBytes(value) {
    if (value === null || value === undefined) {
        return '—';
    }
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let size = Number(value);
    let unitIndex = 0;
    while (size >= 1024 && unitIndex < units.length - 1) {
        size /= 1024;
        unitIndex += 1;
    }
    return `${size.toFixed(1)} ${units[unitIndex]}`;
}

function formatMemory(usage, limit) {
    if (!usage || !limit) {
        return '—';
    }
    return `${formatBytes(usage)} / ${formatBytes(limit)}`;
}

async function loadMemoryStats() {
    try {
        const stats = await fetch('/api/memory/stats').then(r => r.json());
        document.getElementById('memory-total').textContent = stats.total || 0;
        const topCategory = (stats.by_category && stats.by_category[0]) ? stats.by_category[0].category : '—';
        document.getElementById('memory-top-category').textContent = topCategory || '—';
        const latest = stats.latest ? new Date(stats.latest.created_at).toLocaleString() : '—';
        document.getElementById('memory-latest').textContent = latest;
    } catch (error) {
        console.error('Error loading memory stats:', error);
    }
}

async function loadMemoryItems() {
    const params = new URLSearchParams({ limit: 50 });
    if (memorySearchTerm) {
        params.append('search', memorySearchTerm);
    }

    try {
        const items = await fetch(`/api/memory/items?${params.toString()}`).then(r => r.json());
        renderMemoryItems(items);
    } catch (error) {
        console.error('Error loading memory items:', error);
        const container = document.getElementById('memory-list');
        container.innerHTML = '<div class="error">Failed to load memory items</div>';
    }
}

async function handleMemorySemanticSearch() {
    const queryInput = document.getElementById('memory-semantic-query');
    const projectInput = document.getElementById('memory-semantic-project');
    const topkInput = document.getElementById('memory-semantic-topk');
    const statusEl = document.getElementById('memory-semantic-status');

    const query = queryInput ? queryInput.value.trim() : '';
    if (!query) {
        if (statusEl) {
            statusEl.textContent = 'Enter a search query first.';
        }
        return;
    }

    const payload = {
        query,
        top_k: Number(topkInput?.value || 8),
    };
    const projectId = projectInput ? projectInput.value.trim() : '';
    if (projectId) {
        payload.project_id = projectId;
    }

    logUiEvent('memory_semantic_search', { query, project_id: projectId || null });
    if (statusEl) {
        statusEl.textContent = 'Searching...';
    }

    try {
        const response = await fetch('/api/memory/search-text', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
        const results = await response.json();
        if (!response.ok) {
            throw new Error(results.detail || 'Search failed');
        }
        memorySemanticActive = true;
        memorySemanticResults = results;
        renderMemoryItems(results);
        if (statusEl) {
            statusEl.textContent = `Found ${results.length} matches.`;
        }
    } catch (error) {
        console.error('Error running semantic search:', error);
        if (statusEl) {
            statusEl.textContent = `Search failed: ${error.message}`;
        }
    }
}

async function handleMemoryAdd(event) {
    event.preventDefault();
    const contentInput = document.getElementById('memory-add-content');
    const projectInput = document.getElementById('memory-add-project');
    const categoriesInput = document.getElementById('memory-add-categories');
    const createdByInput = document.getElementById('memory-add-created-by');
    const statusEl = document.getElementById('memory-add-status');

    const content = contentInput ? contentInput.value.trim() : '';
    if (!content) {
        if (statusEl) {
            statusEl.textContent = 'Content is required.';
        }
        return;
    }

    const payload = { content };
    const projectId = projectInput ? projectInput.value.trim() : '';
    if (projectId) {
        payload.project_id = projectId;
    }
    const categoriesRaw = categoriesInput ? categoriesInput.value.trim() : '';
    if (categoriesRaw) {
        payload.categories = categoriesRaw.split(',').map((c) => c.trim()).filter(Boolean);
    }
    const createdBy = createdByInput ? createdByInput.value.trim() : '';
    if (createdBy) {
        payload.created_by = createdBy;
    }

    logUiEvent('memory_add', { project_id: projectId || null });
    if (statusEl) {
        statusEl.textContent = 'Adding...';
    }

    try {
        const response = await fetch('/api/memory/items', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
        const result = await response.json();
        if (!response.ok) {
            throw new Error(normalizeErrorDetail(result.detail) || 'Add failed');
        }
        if (statusEl) {
            statusEl.textContent = `Added memory ${result.memory_id?.slice(0, 8) || ''}`;
        }
        if (contentInput) {
            contentInput.value = '';
        }
        await loadMemoryStats();
        await loadMemoryItems();
    } catch (error) {
        console.error('Error adding memory:', error);
        if (statusEl) {
            statusEl.textContent = `Add failed: ${error.message}`;
        }
    }
}

async function handleMemoryIndex(event) {
    event.preventDefault();
    const projectInput = document.getElementById('memory-index-project');
    const repoInput = document.getElementById('memory-index-repo');
    const modelInput = document.getElementById('memory-index-model');
    const forceInput = document.getElementById('memory-index-force');
    const statusEl = document.getElementById('memory-index-status');

    const projectId = projectInput ? projectInput.value.trim() : '';
    if (!projectId) {
        if (statusEl) {
            statusEl.textContent = 'Project ID is required.';
        }
        return;
    }

    const payload = {
        force_reindex: Boolean(forceInput?.checked),
        ...approvalMetadata('webui-memory-code-index'),
    };
    const repoPath = repoInput ? repoInput.value.trim() : '';
    if (repoPath) {
        payload.repo_path = repoPath;
    }
    const modelId = modelInput ? modelInput.value.trim() : '';
    if (modelId) {
        payload.model_id = modelId;
    }

    logUiEvent('memory_index', { project_id: projectId, repo_path: repoPath || null });
    if (statusEl) {
        statusEl.textContent = 'Queuing...';
    }

    try {
        const response = await fetch(`/api/memory/code-index/${projectId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
        const result = await response.json();
        if (!response.ok) {
            throw new Error(result.detail || 'Index queue failed');
        }
        if (statusEl) {
            statusEl.textContent = `Queued ${result.task_id?.slice(0, 8) || 'job'}.`;
        }
    } catch (error) {
        console.error('Error queueing code index:', error);
        if (statusEl) {
            statusEl.textContent = `Queue failed: ${error.message}`;
        }
    }
}

function renderMemoryItems(items) {
    const container = document.getElementById('memory-list');
    if (!items || items.length === 0) {
        container.innerHTML = '<div class="empty-state">No memory entries found</div>';
        return;
    }

    container.innerHTML = items.map(item => `
        <div class="memory-card">
            <div class="memory-content">${renderMemorySnippet(item.content)}</div>
            <div class="memory-meta">
                <span>ID: ${item.memory_id.slice(0, 8)}…</span>
                <span>Project: ${item.project_id || '—'}</span>
                ${item.scope ? `<span>Scope: ${item.scope}</span>` : ''}
                <span>Created: ${new Date(item.created_at).toLocaleString()}</span>
                <span>Feedback: ${item.user_feedback ?? 0}</span>
                ${item.similarity !== undefined ? `<span>Similarity: ${item.similarity.toFixed(3)}</span>` : ''}
            </div>
            <div class="memory-tags">
                ${(item.categories || []).map(cat => `<span class="memory-tag">${cat}</span>`).join('')}
            </div>
            <div class="memory-actions">
                <button onclick="handleMemoryFeedback('${item.memory_id}', 1)">👍 Good</button>
                <button onclick="handleMemoryFeedback('${item.memory_id}', -1)">👎 Bad</button>
                <button onclick="handleMemoryDelete('${item.memory_id}')">🗑️ Delete</button>
            </div>
        </div>
    `).join('');
}

function renderGlobalMemoryItems(items) {
    const container = document.getElementById('global-search-results');
    if (!container) return;
    if (!items || items.length === 0) {
        container.innerHTML = '<div class="empty-state">No global memory entries found</div>';
        return;
    }

    container.innerHTML = items.map(item => `
        <div class="memory-card">
            <div class="memory-content">${renderMemorySnippet(item.content)}</div>
            <div class="memory-meta">
                <span>ID: ${item.memory_id.slice(0, 8)}…</span>
                <span>Scope: Global</span>
                <span>Created: ${new Date(item.created_at).toLocaleString()}</span>
                <span>Feedback: ${item.user_feedback ?? 0}</span>
                ${item.similarity !== undefined ? `<span>Similarity: ${item.similarity.toFixed(3)}</span>` : ''}
            </div>
            <div class="memory-tags">
                ${(item.categories || []).map(cat => `<span class="memory-tag">${cat}</span>`).join('')}
            </div>
        </div>
    `).join('');
}

async function handleMemoryDelete(memoryId) {
    if (!confirm('Delete this memory entry?')) {
        return;
    }
    logUiEvent('memory_delete', { memory_id: memoryId });
    try {
        const response = await fetch(`/api/memory/items/${memoryId}`, { method: 'DELETE' });
        if (!response.ok) {
            const result = await response.json();
            throw new Error(result.detail || 'Delete failed');
        }
        loadMemoryItems();
        loadMemoryStats();
    } catch (error) {
        console.error('Error deleting memory:', error);
        alert('Failed to delete memory: ' + error.message);
    }
}

async function handleMemoryFeedback(memoryId, delta) {
    logUiEvent('memory_feedback', { memory_id: memoryId, delta });
    try {
        const response = await fetch('/api/memory/feedback', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ memory_id: memoryId, feedback: delta })
        });
        if (!response.ok) {
            const result = await response.json();
            throw new Error(result.detail || 'Feedback update failed');
        }
        loadMemoryItems();
    } catch (error) {
        console.error('Error updating feedback:', error);
        alert('Failed to update feedback: ' + error.message);
    }
}

async function handleGlobalEmbeddingSubmit(event) {
    event.preventDefault();
    const statusEl = document.getElementById('global-embed-status');
    const pathsInput = document.getElementById('global-embed-paths');
    const modeSelect = document.getElementById('global-embed-mode');
    const codeModelInput = document.getElementById('global-embed-code-model');
    const textModelInput = document.getElementById('global-embed-text-model');
    const forceToggle = document.getElementById('global-embed-force');

    const rawPaths = pathsInput ? pathsInput.value.split('\n') : [];
    const repoPaths = rawPaths.map(line => line.trim()).filter(Boolean);
    if (repoPaths.length === 0) {
        if (statusEl) statusEl.textContent = 'Enter at least one repository path.';
        return;
    }

    const payload = {
        repo_paths: repoPaths,
        mode: modeSelect ? modeSelect.value : 'auto',
        force_reindex: forceToggle ? forceToggle.checked : false,
        ...approvalMetadata('webui-memory-global-index'),
    };
    if (codeModelInput && codeModelInput.value.trim()) {
        payload.code_model_id = codeModelInput.value.trim();
    }
    if (textModelInput && textModelInput.value.trim()) {
        payload.text_model_id = textModelInput.value.trim();
    }

    logUiEvent('global_embedding_start', { repo_paths: repoPaths, mode: payload.mode });
    if (statusEl) statusEl.textContent = 'Queueing...';

    try {
        const response = await fetch('/api/memory/global/index', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
        const result = await response.json();
        if (!response.ok) {
            throw new Error(result.detail || 'Unable to queue global embedding');
        }
        if (statusEl) statusEl.textContent = `Queued ${result.task_id?.slice(0, 8) || 'job'}.`;
        await loadGlobalEmbeddingStats();
    } catch (error) {
        console.error('Error queueing global embedding:', error);
        if (statusEl) statusEl.textContent = `Queue failed: ${error.message}`;
    }
}

async function handleGlobalSearch() {
    const queryInput = document.getElementById('global-search-query');
    const query = queryInput ? queryInput.value.trim() : '';
    if (!query) {
        return;
    }
    logUiEvent('global_memory_search', { query });
    try {
        const response = await fetch('/api/memory/global/search-text', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query, top_k: 8 }),
        });
        const results = await response.json();
        if (!response.ok) {
            throw new Error(results.detail || 'Global search failed');
        }
        renderGlobalMemoryItems(results);
    } catch (error) {
        console.error('Error searching global memory:', error);
        const container = document.getElementById('global-search-results');
        if (container) {
            container.innerHTML = `<div class="error">Search failed: ${error.message}</div>`;
        }
    }
}

async function loadGlobalEmbeddingStats() {
    try {
        const response = await fetch('/api/memory/global/stats');
        const payload = await response.json();
        if (!response.ok) {
            throw new Error(payload.detail || 'Failed to load global stats');
        }
        const totalEl = document.getElementById('global-embedding-total');
        if (totalEl) totalEl.textContent = payload.total ?? 0;
        const ratioEl = document.getElementById('global-embedding-ratio');
        if (ratioEl) ratioEl.textContent = (payload.overall_frequency_ratio ?? 0).toFixed(2);
        renderGlobalTopUsed(payload.top_used || []);
    } catch (error) {
        console.error('Error loading global embedding stats:', error);
    }
}

async function loadAstProgress() {
    const statusEl = document.getElementById('ast-progress-status');
    const metaEl = document.getElementById('ast-progress-meta');
    const fileEl = document.getElementById('ast-progress-file');
    try {
        const response = await fetch('/api/memory/embedding-runs?status=running&limit=1');
        const runs = await response.json();
        if (!response.ok) {
            throw new Error(runs.detail || 'Failed to load embedding runs');
        }
        const run = Array.isArray(runs) && runs.length ? runs[0] : null;
        renderAstProgress(run);
        if (statusEl) {
            statusEl.textContent = run ? `Running ${run.mode?.toUpperCase() || ''}` : 'Idle';
        }
        if (metaEl) {
            metaEl.textContent = run ? `Target: ${run.target} · Started ${formatTimeSince(run.started_at)}` : 'No active embedding run.';
        }
        if (fileEl) {
            const currentFile = run?.stats?.progress?.current_file;
            fileEl.textContent = currentFile ? `Now parsing: ${currentFile}` : '';
        }
    } catch (error) {
        if (statusEl) statusEl.textContent = 'Unavailable';
        if (metaEl) metaEl.textContent = 'Unable to read AST progress.';
        if (fileEl) fileEl.textContent = '';
        renderAstProgress(null);
    }
}

function renderAstProgress(run) {
    const canvas = document.getElementById('ast-progress-canvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (!run || !run.stats || !run.stats.progress) {
        ctx.fillStyle = '#94a3b8';
        ctx.font = '12px system-ui, sans-serif';
        ctx.fillText('No active AST parse.', 20, 30);
        return;
    }

    const progress = run.stats.progress || {};
    const astOk = progress.ast_success || 0;
    const astFail = progress.ast_failure || 0;
    const processed = progress.files_processed || 0;
    const total = progress.files_total || 0;
    const maxAst = Math.max(astOk, astFail, 1);
    const padding = 24;
    const width = canvas.width - padding * 2;
    const height = canvas.height - padding * 2;

    ctx.fillStyle = '#e2e8f0';
    ctx.font = '12px system-ui, sans-serif';
    ctx.fillText('AST success vs fail', padding, padding - 6);

    const barWidth = 80;
    const okHeight = (astOk / maxAst) * (height - 40);
    const failHeight = (astFail / maxAst) * (height - 40);
    const baseY = padding + (height - 40);
    ctx.fillStyle = '#10b981';
    ctx.fillRect(padding, baseY - okHeight, barWidth, okHeight);
    ctx.fillStyle = '#ef4444';
    ctx.fillRect(padding + barWidth + 24, baseY - failHeight, barWidth, failHeight);

    ctx.fillStyle = '#cbd5e1';
    ctx.fillText(`OK: ${astOk}`, padding, baseY + 18);
    ctx.fillText(`Fail: ${astFail}`, padding + barWidth + 24, baseY + 18);

    const progressY = padding + height - 10;
    const ratio = total ? processed / total : 0;
    ctx.fillStyle = 'rgba(148, 163, 184, 0.3)';
    ctx.fillRect(padding + 220, progressY - 8, width - 240, 8);
    ctx.fillStyle = '#3b82f6';
    ctx.fillRect(padding + 220, progressY - 8, (width - 240) * ratio, 8);
    ctx.fillStyle = '#e2e8f0';
    ctx.fillText(`Files: ${processed}/${total || '—'}`, padding + 220, progressY - 14);
}

function renderGlobalTopUsed(items) {
    const container = document.getElementById('global-embedding-top');
    if (!container) return;
    if (!items.length) {
        container.innerHTML = '<div class="empty-state">No global embeddings yet</div>';
        return;
    }
    container.innerHTML = `
        <div class="data-row header three-col">
            <div>Memory ID</div>
            <div>Accesses</div>
            <div>Created</div>
        </div>
        ${items.map(item => `
            <div class="data-row three-col">
                <div>${String(item.memory_id).slice(0, 8)}…</div>
                <div>${item.access_count ?? 0}</div>
                <div>${item.created_at ? new Date(item.created_at).toLocaleDateString() : '—'}</div>
            </div>
        `).join('')}
    `;
}

function renderMemorySnippet(content) {
    const value = content || '';
    const snippet = value.slice(0, 400);
    return `${escapeHtml(snippet)}${value.length > 400 ? '…' : ''}`;
}

function escapeHtml(text = '') {
    return text.replace(/[&<>'"]/g, (char) => {
        const map = {
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            "'": '&#39;',
            '"': '&quot;'
        };
        return map[char] || char;
    });
}

// Logs View
async function loadLogsView() {
    logUiEvent('logs_view_load', {
        min_level: logViewerSettings.minLevel,
        include_access: logViewerSettings.includeAccess,
    });
    await Promise.all([loadLogConfig(), loadLogEntries()]);
}

async function loadLogConfig() {
    const targetSelect = document.getElementById('server-log-target');
    const levelSelect = document.getElementById('server-log-level');
    if (!targetSelect || !levelSelect) {
        return;
    }
    try {
        const config = await fetch('/api/logs/levels').then(r => r.json());
        if (Array.isArray(config.available_levels) && config.available_levels.length > 0) {
            levelSelect.innerHTML = config.available_levels.map(level => `
                <option value="${level}">${level.charAt(0)}${level.slice(1).toLowerCase()}</option>
            `).join('');
        }
        if (Array.isArray(config.loggers) && config.loggers.length > 0) {
            const previousTarget = targetSelect.value;
            targetSelect.innerHTML = config.loggers.map(entry => `
                <option value="${entry.name}">${entry.name} (${entry.level})</option>
            `).join('');
            const selectedEntry = config.loggers.find(entry => entry.name === previousTarget) || config.loggers[0];
            if (selectedEntry) {
                targetSelect.value = selectedEntry.name;
                levelSelect.value = selectedEntry.level || logViewerSettings.minLevel;
            }
        }
    } catch (error) {
        console.error('Error loading log level metadata:', error);
    }
}

async function loadLogEntries() {
    const params = new URLSearchParams({
        limit: '500',
        min_level: logViewerSettings.minLevel,
    });
    if (logViewerSettings.includeAccess) {
        params.append('include_access', 'true');
    }
    try {
        const response = await fetch(`/api/logs?${params.toString()}`);
        const data = await response.json();
        renderLogEntries(data.logs || []);
    } catch (error) {
        console.error('Error loading logs:', error);
        const container = document.getElementById('logs-output');
        if (container) {
            container.innerHTML = '<div class="error">Failed to load logs</div>';
        }
    }
}

function renderLogEntries(entries) {
    const container = document.getElementById('logs-output');
    if (!container) {
        return;
    }
    if (!entries || entries.length === 0) {
        container.innerHTML = '<div class="empty-state">No log entries</div>';
        return;
    }
    container.innerHTML = entries.map(entry => {
        const timestamp = entry.timestamp
            ? new Date(entry.timestamp).toLocaleTimeString()
            : new Date().toLocaleTimeString();
        const loggerName = escapeHtml(entry.logger || 'unknown');
        const message = escapeHtml(entry.message || '');
        const level = (entry.level || 'INFO').toUpperCase();
        return `
            <div class="log-entry level-${level}">
                <div class="log-meta">
                    <span>${timestamp}</span>
                    <span>${level}</span>
                    <span class="log-source">${loggerName}</span>
                </div>
                <div class="log-message">${message}</div>
            </div>
        `;
    }).join('');
}

async function applyServerLogLevel() {
    const loggerSelect = document.getElementById('server-log-target');
    const levelSelect = document.getElementById('server-log-level');
    const status = document.getElementById('log-level-status');
    if (!loggerSelect || !levelSelect) {
        return;
    }
    const payload = {
        logger_name: loggerSelect.value || 'root',
        level: levelSelect.value || 'INFO',
    };
    logUiEvent('logs_level_change', payload);
    try {
        const response = await fetch('/api/logs/level', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
        const result = await response.json();
        if (!response.ok) {
            throw new Error(result.detail || 'Failed to update log level');
        }
        if (status) {
            status.textContent = `Set ${result.name} to ${result.level}`;
        }
        await loadLogConfig();
    } catch (error) {
        console.error('Error updating log level:', error);
        if (status) {
            status.textContent = `Error: ${error.message}`;
        }
    }
}

// WebSocket message handlers
function updateWorkerStatus(data) {
    // Refresh workers if on orchestrator view
    if (currentView === 'orchestrator') {
        loadWorkers();
    }
}

function updateTaskStatus(data) {
    // Refresh task queue if on orchestrator view
    if (currentView === 'orchestrator') {
        loadTaskQueue();
    }
}

function handleTaskComplete(data) {
    // Refresh dashboard stats
    loadDashboard();
    // Show notification
    console.log('Task completed:', data.task_id);
}
