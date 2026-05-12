// AI Orchestrator Web Viewer - Frontend Application

// State
let ws = null;
let currentView = 'dashboard';
const storedView = window.localStorage.getItem('currentView');
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
let availableGpuDevices = [];
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
const GLOBAL_RAG_PROJECT_ID = '00000000-0000-0000-0000-000000000000';
let manualTaskProjectOptions = [];
let activeManualTaskProjectIndex = -1;
const VALID_VIEWS = new Set(['dashboard', 'orchestrator', 'tasks', 'memory', 'embeddings', 'system']);

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

function escapeHtml(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
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
    if (typeof loadProjectTextSources === 'function') {
        loadProjectTextSources();
    }
    if (typeof loadKnowledgeSourcesPanel === 'function') {
        loadKnowledgeSourcesPanel();
    }
    if (typeof refreshManualTaskOptions === 'function') {
        refreshManualTaskOptions();
    }
    if (typeof syncManualTaskProjectSelection === 'function') {
        syncManualTaskProjectSelection();
    }
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
    setupEmbeddingsControls();
    startSystemMeter();
    checkServiceAvailability();

    if (storedView && VALID_VIEWS.has(storedView) && storedView !== 'dashboard') {
        switchView(storedView, 'restore');
    }

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
    window.localStorage.setItem('currentView', view);
    logUiEvent('view_switch', { from: previousView, to: view, reason });

    // Chat view needs full-height layout — toggle body class to override container styles
    document.body.classList.toggle('chat-mode', view === 'chat');

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
        case 'chat':
            if (window.chatViewActivated) window.chatViewActivated();
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
        const [stats, tasks] = await Promise.all([
            fetch('/api/orchestrator/stats').then(r => r.json()),
            fetch('/api/tasks?limit=8').then(r => r.json()),
        ]);

        document.getElementById('stat-workers').textContent = stats.active_workers || 0;
        document.getElementById('stat-queued').textContent = stats.queued || 0;
        document.getElementById('stat-completed').textContent = stats.completed || 0;
        document.getElementById('stat-failed').textContent = stats.failed || 0;

        const activityFeed = document.getElementById('activity-feed');
        if (activityFeed) {
            if (!Array.isArray(tasks) || !tasks.length) {
                activityFeed.innerHTML = '<div class="activity-item">No recent task activity.</div>';
            } else {
                activityFeed.innerHTML = tasks.map((task) => `
                    <div class="activity-item">
                        <div><strong>${escapeHtml(task.title || 'Untitled task')}</strong></div>
                        <div class="microcopy">
                            ${escapeHtml(getProjectName(task.project_id))} ·
                            ${escapeHtml(normalizeTaskStatusValue(task.status))} ·
                            ${escapeHtml(formatDate(task.modified_at || task.created_at))}
                        </div>
                    </div>
                `).join('');
            }
        }
    } catch (error) {
        console.error('Error loading dashboard:', error);
        const activityFeed = document.getElementById('activity-feed');
        if (activityFeed) {
            activityFeed.innerHTML = '<div class="activity-item">Failed to load recent activity.</div>';
        }
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
    refreshManualTaskOptions();
    syncManualTaskProjectSelection();
}

function setupModelControls() {
    const saveBtn = document.getElementById('model-save-btn');
    if (saveBtn) {
        saveBtn.addEventListener('click', saveModelSelection);
    }
}

function setupManualTaskForm() {
    const form = document.getElementById('manual-task-form');
    const projectNameInput = document.getElementById('manual-task-project-name');
    const workingDirInput = document.getElementById('manual-task-working-dir');
    const projectOptions = document.getElementById('manual-task-project-options');
    if (form) {
        form.addEventListener('submit', submitManualTask);
    }
    if (projectNameInput) {
        projectNameInput.addEventListener('focus', () => renderManualTaskProjectOptions(projectNameInput.value));
        projectNameInput.addEventListener('input', () => {
            const hiddenInput = document.getElementById('manual-task-project');
            if (hiddenInput) hiddenInput.value = '';
            activeManualTaskProjectIndex = -1;
            syncManualTaskProjectSelection();
            renderManualTaskProjectOptions(projectNameInput.value);
        });
        projectNameInput.addEventListener('keydown', handleManualTaskProjectKeydown);
        projectNameInput.addEventListener('blur', () => {
            window.setTimeout(() => {
                projectOptions?.classList.add('hidden');
            }, 120);
        });
    }
    if (projectOptions) {
        projectOptions.addEventListener('mousedown', (event) => {
            const option = event.target.closest('.project-option');
            if (!option) return;
            event.preventDefault();
            const selected = projectsCache.find((project) => project.id === option.dataset.projectId);
            if (selected) {
                chooseManualTaskProject(selected);
            }
        });
    }
    if (workingDirInput) {
        workingDirInput.addEventListener('input', () => {
            workingDirInput.dataset.autoFilled = 'false';
        });
    }
}

function setupMemoryControls() {
    const refreshBtn = document.getElementById('memory-refresh-btn');
    const searchInput = document.getElementById('memory-search');
    const semanticBtn = document.getElementById('memory-semantic-btn');
    const semanticClearBtn = document.getElementById('memory-semantic-clear');
    const memoryAddForm = document.getElementById('memory-add-form');
    const memoryIndexForm = document.getElementById('memory-index-form');
    const projectSourceUploadForm = document.getElementById('project-source-upload-form');
    const projectTextSearchForm = document.getElementById('project-text-search-form');
    const knowledgeSourceUploadForm = document.getElementById('knowledge-source-upload-form');
    const knowledgeSourceSearchBtn = document.getElementById('knowledge-source-search-btn');
    const knowledgeSourceScope = document.getElementById('knowledge-source-scope');
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
    if (projectSourceUploadForm) {
        projectSourceUploadForm.addEventListener('submit', handleProjectSourceUpload);
    }
    if (projectTextSearchForm) {
        projectTextSearchForm.addEventListener('submit', handleProjectTextSearch);
    }
    if (knowledgeSourceUploadForm) {
        knowledgeSourceUploadForm.addEventListener('submit', handleKnowledgeSourceUpload);
    }
    if (knowledgeSourceSearchBtn) {
        knowledgeSourceSearchBtn.addEventListener('click', handleKnowledgeSourceSearch);
    }
    if (knowledgeSourceScope) {
        knowledgeSourceScope.addEventListener('change', () => {
            if (typeof loadKnowledgeSourcesPanel === 'function') {
                loadKnowledgeSourcesPanel();
            }
            if (typeof runKnowledgeSourceSearch === 'function') {
                runKnowledgeSourceSearch(false);
            }
        });
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
    const hfSearchBtn = document.getElementById('lmstudio-hf-search-btn');
    const hfQuery = document.getElementById('lmstudio-hf-query');
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
    if (hfSearchBtn) {
        hfSearchBtn.addEventListener('click', handleLmstudioHfSearch);
    }
    if (hfQuery) {
        hfQuery.addEventListener('keydown', (e) => { if (e.key === 'Enter') handleLmstudioHfSearch(); });
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
    const status = document.getElementById('model-status');
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
        const activeModel = availableModels.find((model) => model.id === select.value);
        if (status && activeModel) {
            status.textContent = activeModel.runtime === 'local'
                ? `Selected local model: ${activeModel.label}`
                : `Selected API model: ${activeModel.label}`;
        }
    } catch (error) {
        console.error('Error loading models:', error);
        if (status) {
            status.textContent = 'Failed to load models';
        }
    }
}

async function saveModelSelection() {
    const select = document.getElementById('model-select');
    const status = document.getElementById('model-status');
    if (!select) return;

    logUiEvent('model_select', { model_id: select.value });
    try {
        if (status) {
            status.textContent = 'Saving model selection...';
        }
        const response = await fetch('/api/control/models/select', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model_id: select.value })
        });
        const payload = await response.json();
        if (!response.ok) {
            throw new Error(normalizeErrorDetail(payload) || 'Failed to update model');
        }
        const selectedModel = availableModels.find((model) => model.id === select.value);
        if (selectedModel && selectedModel.runtime === 'local' && selectedModel.lmstudio_model) {
            if (status) {
                status.textContent = `Loading ${selectedModel.label} into LM Studio...`;
            }
            const loadResponse = await fetch('/api/lmstudio/load', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    path: selectedModel.lmstudio_model,
                    identifier: selectedModel.lmstudio_identifier || selectedModel.id,
                    gpu: selectedModel.gpu || 'max',
                    context_length: selectedModel.context_length || 32768,
                    yes: true,
                }),
            });
            const loadPayload = await loadResponse.json();
            if (!loadResponse.ok) {
                throw new Error(normalizeErrorDetail(loadPayload) || 'LM Studio load failed');
            }
            if (status) {
                status.textContent = `${selectedModel.label} selected and load requested.`;
            }
            return;
        }
        if (status) {
            status.textContent = 'Model updated successfully';
        }
    } catch (error) {
        console.error('Error updating model:', error);
        if (status) {
            status.textContent = `Failed to update model: ${error.message}`;
        }
    }
}

function findProjectByName(name) {
    const target = (name || '').trim().toLowerCase();
    if (!target) return null;
    return projectsCache.find((project) => (project.name || '').trim().toLowerCase() === target) || null;
}

function scoreProjectMatch(projectName, query) {
    const source = (projectName || '').trim().toLowerCase();
    const target = (query || '').trim().toLowerCase();
    if (!target) {
        return source ? 1 : 0;
    }
    if (!source) {
        return 0;
    }
    if (source === target) {
        return 1000;
    }
    if (source.startsWith(target)) {
        return 700 - (source.length - target.length);
    }
    if (source.includes(target)) {
        return 500 - source.indexOf(target);
    }
    let score = 0;
    let cursor = 0;
    for (const char of target) {
        const index = source.indexOf(char, cursor);
        if (index === -1) {
            return 0;
        }
        score += 8;
        if (index === cursor) {
            score += 4;
        }
        cursor = index + 1;
    }
    return score;
}

function getFilteredManualTaskProjects(query = '') {
    return [...projectsCache]
        .map((project) => ({ project, score: scoreProjectMatch(project.name, query) }))
        .filter((entry) => entry.score > 0)
        .sort((a, b) => {
            if (b.score !== a.score) {
                return b.score - a.score;
            }
            return (a.project.name || '').localeCompare(b.project.name || '', undefined, { sensitivity: 'base' });
        })
        .map((entry) => entry.project);
}

function renderManualTaskProjectOptions(query = '') {
    const container = document.getElementById('manual-task-project-options');
    if (!container) {
        return;
    }
    manualTaskProjectOptions = getFilteredManualTaskProjects(query);
    if (!manualTaskProjectOptions.length) {
        container.innerHTML = '<div class="project-option-empty">No matching projects.</div>';
        container.classList.remove('hidden');
        activeManualTaskProjectIndex = -1;
        return;
    }
    if (activeManualTaskProjectIndex >= manualTaskProjectOptions.length) {
        activeManualTaskProjectIndex = 0;
    }
    container.innerHTML = manualTaskProjectOptions.map((project, index) => {
        const tracking = projectTracking[project.id] || {};
        const repoPath = tracking.repo_path || (tracking.repo_paths || [])[0] || 'No tracked repo path';
        return `
            <div class="project-option ${index === activeManualTaskProjectIndex ? 'active' : ''}" data-project-id="${project.id}" role="option" aria-selected="${index === activeManualTaskProjectIndex}">
                <div class="project-option-name">${escapeHtml(project.name)}</div>
                <div class="project-option-meta">${escapeHtml(repoPath)}</div>
            </div>
        `;
    }).join('');
    container.classList.remove('hidden');
}

function chooseManualTaskProject(project) {
    const nameInput = document.getElementById('manual-task-project-name');
    const hiddenInput = document.getElementById('manual-task-project');
    const options = document.getElementById('manual-task-project-options');
    if (!nameInput || !hiddenInput) {
        return;
    }
    nameInput.value = project.name || '';
    hiddenInput.value = project.id || '';
    activeManualTaskProjectIndex = manualTaskProjectOptions.findIndex((entry) => entry.id === project.id);
    syncManualTaskProjectSelection();
    options?.classList.add('hidden');
}

function handleManualTaskProjectKeydown(event) {
    const options = document.getElementById('manual-task-project-options');
    if (!options || options.classList.contains('hidden')) {
        if (event.key === 'ArrowDown') {
            renderManualTaskProjectOptions(event.target.value);
            event.preventDefault();
        }
        return;
    }
    if (event.key === 'ArrowDown') {
        activeManualTaskProjectIndex = Math.min(activeManualTaskProjectIndex + 1, manualTaskProjectOptions.length - 1);
        renderManualTaskProjectOptions(event.target.value);
        event.preventDefault();
        return;
    }
    if (event.key === 'ArrowUp') {
        activeManualTaskProjectIndex = Math.max(activeManualTaskProjectIndex - 1, 0);
        renderManualTaskProjectOptions(event.target.value);
        event.preventDefault();
        return;
    }
    if (event.key === 'Enter') {
        if (activeManualTaskProjectIndex >= 0 && manualTaskProjectOptions[activeManualTaskProjectIndex]) {
            chooseManualTaskProject(manualTaskProjectOptions[activeManualTaskProjectIndex]);
            event.preventDefault();
            return;
        }
        const exactMatch = findProjectByName(event.target.value);
        if (exactMatch) {
            chooseManualTaskProject(exactMatch);
            event.preventDefault();
        }
        return;
    }
    if (event.key === 'Escape') {
        options.classList.add('hidden');
    }
}

function syncManualTaskProjectSelection() {
    const nameInput = document.getElementById('manual-task-project-name');
    const hiddenInput = document.getElementById('manual-task-project');
    const workingDirInput = document.getElementById('manual-task-working-dir');
    const helpEl = document.getElementById('manual-task-project-help');
    if (!nameInput || !hiddenInput || !workingDirInput) {
        return;
    }

    const matchedProject = projectsCache.find((project) => project.id === hiddenInput.value) || findProjectByName(nameInput.value);
    if (!matchedProject) {
        hiddenInput.value = '';
        if (workingDirInput.dataset.autoFilled === 'true') {
            workingDirInput.value = '';
        }
        if (helpEl) {
            helpEl.textContent = nameInput.value.trim() ? 'Choose a project from the known project list.' : '';
        }
        return;
    }

    hiddenInput.value = matchedProject.id;
    const tracking = projectTracking[matchedProject.id] || {};
    const defaultPath = tracking.repo_path || (tracking.repo_paths || [])[0] || '';
    if (!workingDirInput.value || workingDirInput.dataset.autoFilled === 'true') {
        workingDirInput.value = defaultPath;
        workingDirInput.dataset.autoFilled = defaultPath ? 'true' : 'false';
    }
    if (helpEl) {
        helpEl.textContent = defaultPath
            ? `Working directory defaulted to ${defaultPath}`
            : 'This project has no tracked repo path yet.';
    }
}

async function submitManualTask(event) {
    event.preventDefault();
    const form = event.target;
    const status = document.getElementById('manual-task-status');
    syncManualTaskProjectSelection();
    const formData = new FormData(form);
    const payload = Object.fromEntries(formData.entries());
    if (!payload.project_id) {
        if (status) {
            status.textContent = 'Select a valid project first.';
        }
        return;
    }
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
        refreshManualTaskOptions();
        syncManualTaskProjectSelection();
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
