/**
 * Service availability detection and status bar.
 * Probes DB, orchestrator, and LM Studio every 30 seconds.
 */

window.ServiceStatus = {
    db: 'unknown',          // 'online' | 'offline' | 'unknown'
    orchestrator: 'unknown',
    lmstudio: 'unknown',
};

async function checkServiceAvailability() {
    const probe = async (url) => {
        try {
            const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
            return response.ok ? 'online' : 'offline';
        } catch (_err) {
            return 'offline';
        }
    };

    const [dbStatus, orchStatus, lmsStatus] = await Promise.all([
        probe('/api/system/db'),
        probe('/api/orchestrator/stats'),
        probe('/api/system/lmstudio'),
    ]);

    window.ServiceStatus.db = dbStatus;
    window.ServiceStatus.orchestrator = orchStatus;
    window.ServiceStatus.lmstudio = lmsStatus;

    renderServiceBadges();
}

function renderServiceBadges() {
    const badges = document.querySelectorAll('.service-badge[data-service]');
    badges.forEach((badge) => {
        const service = badge.dataset.service;
        const status = window.ServiceStatus[service] || 'unknown';
        badge.classList.remove('online', 'offline');
        if (status === 'online') {
            badge.classList.add('online');
        } else if (status === 'offline') {
            badge.classList.add('offline');
        }
    });

    // Mark memory/embeddings nav buttons as service-offline when orchestrator is down
    const orchOffline = window.ServiceStatus.orchestrator === 'offline';
    document.querySelectorAll('.nav-btn[data-view="memory"], .nav-btn[data-view="embeddings"]').forEach((btn) => {
        btn.classList.toggle('service-offline', orchOffline);
    });
}

// Start polling
setInterval(checkServiceAvailability, 30000);
