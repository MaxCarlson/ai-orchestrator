/**
 * Knowledge Manager / Tasks view functions.
 * Extracted from app.js lines 920-2238.
 * Globals (let/const) remain in app.js.
 */
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
    const hiddenInput = document.getElementById('manual-task-project');
    const nameInput = document.getElementById('manual-task-project-name');
    const datalist = document.getElementById('manual-task-project-options');
    if (!hiddenInput || !nameInput || !datalist) return;
    if (!projectsCache.length) {
        datalist.innerHTML = '';
        nameInput.value = '';
        hiddenInput.value = '';
        return;
    }
    const ordered = [...projectsCache].sort((a, b) => {
        return (a.name || '').localeCompare(b.name || '', undefined, { sensitivity: 'base' });
    });
    datalist.innerHTML = ordered
        .map(project => `<option value="${project.name}" data-project-id="${project.id}"></option>`)
        .join('');
    const selected = ordered.find(project => project.id === selectedProject) || ordered[0];
    if (selected) {
        hiddenInput.value = selected.id;
        nameInput.value = selected.name;
    }

    const pathsDatalist = document.getElementById('manual-task-paths');
    if (!pathsDatalist) return;
    const paths = new Set();
    Object.values(projectTracking || {}).forEach((entry) => {
        (entry.repo_paths || []).forEach((path) => paths.add(path));
        if (entry.repo_path) paths.add(entry.repo_path);
    });
    pathsDatalist.innerHTML = Array.from(paths)
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
