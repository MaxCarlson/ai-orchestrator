"""
Main dashboard screen for orchestrator viewer.

Shows:
- System statistics (top)
- Active workers grid (center)
- Activity log (bottom)
"""

import os
from pathlib import Path
from typing import List, Optional
from datetime import datetime

from textual.app import ComposeResult
from textual.binding import Binding
from textual.containers import Container, Vertical, Horizontal, Grid
from textual.reactive import reactive
from textual.screen import Screen
from textual.widgets import Header, Footer, Static, Label
from textual.timer import Timer

from ..widgets.system_stats import SystemStatsPanel
from ..widgets.worker_grid import WorkerGridPanel
from ..widgets.activity_log import ActivityLogPanel


class DashboardScreen(Screen):
    """
    Main orchestrator dashboard screen.

    Layout:
    - Header
    - System stats panel (top, fixed height)
    - Worker grid (center, expandable)
    - Activity log (bottom, fixed height)
    - Footer

    Bindings:
    - Arrow keys: Navigate worker grid
    - Enter: Open worker detail view
    - R: Reload all data
    - Q: Quit
    """

    BINDINGS = [
        Binding("up,down,left,right", "navigate_grid", "Navigate", show=False),
        Binding("enter", "open_worker_detail", "Detail View", show=True),
        Binding("r", "reload", "Reload", show=True),
        Binding("escape,q", "back", "Quit", show=True),
    ]

    # Reactive properties
    selected_worker_index: reactive[int] = reactive(0)
    update_interval: float = 2.0  # Update every 2 seconds

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self._update_timer: Optional[Timer] = None

    def compose(self) -> ComposeResult:
        """Create dashboard layout."""
        yield Header(name="AI Orchestrator Dashboard")

        with Vertical(id="dashboard_container"):
            # System stats at top
            yield SystemStatsPanel()

            # Worker grid in center (expandable)
            yield WorkerGridPanel()

            # Activity log at bottom
            yield ActivityLogPanel()

        yield Footer()

    async def on_mount(self) -> None:
        """Initialize dashboard and start auto-refresh."""
        # Initial load
        await self.reload_all()

        # Start auto-refresh timer
        self._update_timer = self.set_interval(
            self.update_interval,
            self.reload_all,
            name="dashboard_updater"
        )

    async def on_unmount(self) -> None:
        """Clean up timer when screen is unmounted."""
        if self._update_timer:
            self._update_timer.stop()

    async def reload_all(self) -> None:
        """Reload all dashboard data."""
        try:
            # Update system stats
            stats_panel = self.query_one(SystemStatsPanel)
            await stats_panel.update_stats()

            # Update worker grid
            worker_grid = self.query_one(WorkerGridPanel)
            await worker_grid.update_workers()

            # Update activity log
            activity_log = self.query_one(ActivityLogPanel)
            await activity_log.update_activities()

        except Exception as e:
            self.app.notify(f"Error updating dashboard: {e}", title="Error", severity="error")

    async def action_navigate_grid(self, direction: str) -> None:
        """Navigate worker grid with arrow keys."""
        worker_grid = self.query_one(WorkerGridPanel)
        await worker_grid.navigate(direction)

    async def action_open_worker_detail(self) -> None:
        """Open detail view for selected worker (Enter key)."""
        worker_grid = self.query_one(WorkerGridPanel)
        selected_worker = worker_grid.get_selected_worker()

        if selected_worker:
            self.app.notify(f"Opening detail view for {selected_worker['id']}")
            # TODO: Push WorkerDetailScreen
            # from .worker_detail import WorkerDetailScreen
            # await self.app.push_screen(WorkerDetailScreen(worker=selected_worker))
        else:
            self.app.notify("No worker selected", severity="warning")

    async def action_reload(self) -> None:
        """Manual reload (R key)."""
        self.app.notify("Reloading dashboard...")
        await self.reload_all()
        self.app.notify("Dashboard reloaded", title="✓ Success")

    async def action_back(self) -> None:
        """Quit application (Escape/Q key)."""
        self.app.exit()
