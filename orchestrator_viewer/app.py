#!/usr/bin/env python3
"""
AI Orchestrator Viewer - Real-time monitoring dashboard

Command: kmorch

Monitors and manages:
- Active CLI workers
- Task queue status
- Token usage and limits
- Memory/RAG statistics
- GPU utilization
- Live worker output
"""

import logging
from textual.app import App, ComposeResult
from textual.binding import Binding

from .screens.dashboard import DashboardScreen

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    filename='/tmp/kmorch.log'
)
logger = logging.getLogger(__name__)


class OrchestratorViewerApp(App):
    """
    Main orchestrator viewer application.

    Features:
    - Real-time worker monitoring
    - Task queue status
    - System metrics dashboard
    - Worker detail drill-down
    - Live output streaming
    """

    TITLE = "AI Orchestrator Dashboard"
    CSS_PATH = "orchestrator.css"

    BINDINGS = [
        Binding("q", "quit", "Quit", show=True, priority=True),
        Binding("r", "reload", "Reload", show=True),
        Binding("h", "help", "Help", show=True),
        Binding("ctrl+c", "quit", "Quit", show=False, priority=True),
    ]

    def on_mount(self) -> None:
        """Initialize app and push main dashboard screen."""
        logger.info("Orchestrator Viewer started")
        self.push_screen(DashboardScreen())

    async def action_reload(self) -> None:
        """Reload all data (R key)."""
        logger.info("Manual reload triggered")
        self.notify("Reloading data...", title="Refresh")
        # Dashboard screen will handle its own reload
        if hasattr(self.screen, 'reload_all'):
            await self.screen.reload_all()

    async def action_help(self) -> None:
        """Show help screen (H key)."""
        help_text = """
# AI Orchestrator Viewer - Help

## Navigation
- **↑↓←→**: Navigate worker grid
- **Enter**: Open worker detail view
- **Esc**: Back to dashboard
- **Q**: Quit application
- **R**: Reload all data
- **H**: This help screen

## Worker States
- **IDLE** (Gray): No task assigned
- **ASSIGNED** (Yellow): Task assigned, not started
- **ACTIVE** (Green): Task in progress
- **STALLED** (Red): No heartbeat detected
- **COMPLETED** (Blue): Task finished successfully
- **FAILED** (Red): Task failed with errors

## Worker Detail View
- **↑↓**: Scroll output
- **F**: Toggle auto-follow logs
- **K**: Kill worker (with confirmation)
- **R**: Restart task
- **S**: Save logs to file
- **Esc**: Back to dashboard

## Task Queue
Tasks are monitored from: {task_queue_path}

## More Info
See: docs/ORCHESTRATOR_VIEWER_DESIGN.md
        """
        self.notify(help_text, title="Help", timeout=30)


def main():
    """Entry point for kmorch command."""
    app = OrchestratorViewerApp()
    app.run()


if __name__ == "__main__":
    main()
