"""
Worker Grid Panel

Displays a grid of active worker cards showing:
- Task title
- Worker status
- Duration
- Progress
- Output preview
"""

from pathlib import Path
from typing import List, Dict, Any, Optional

from textual.widgets import Static
from textual.containers import Grid
from textual.reactive import reactive

import sys
sys.path.insert(0, str(Path(__file__).parent.parent.parent))
from shared.task_queue import TaskQueue, TaskStatus


class WorkerCard(Static):
    """
    Individual worker card widget.

    Shows task info, status, and output preview.
    """

    def __init__(self, worker_data: Optional[Dict[str, Any]] = None, **kwargs):
        super().__init__(**kwargs)
        self.worker_data = worker_data or {}
        self.add_class("worker-card")

        # Add status class for styling
        status = self.worker_data.get("status", "idle")
        self.add_class(status.lower())

    def render(self) -> str:
        """Render worker card content."""
        if not self.worker_data or self.worker_data.get("status") == "idle":
            return "[dim]═══ IDLE ═══\n\nNo task assigned[/dim]"

        task_title = self.worker_data.get("task_title", "Unknown")[:25]
        status = self.worker_data.get("status", "unknown").upper()
        duration = self.worker_data.get("duration", "0s")
        tokens = self.worker_data.get("tokens_used", 0)
        progress = self.worker_data.get("progress", 0)

        # Status badge with color
        status_colors = {
            "QUEUED": "dim",
            "ASSIGNED": "yellow",
            "IN_PROGRESS": "green",
            "COMPLETED": "cyan",
            "FAILED": "red"
        }
        status_color = status_colors.get(status, "dim")

        # Progress bar
        bar_width = 20
        filled = int((progress / 100) * bar_width)
        bar = "▓" * filled + "░" * (bar_width - filled)

        lines = [
            f"[bold]{task_title}[/bold]",
            f"[{status_color}]● {status}[/{status_color}] │ {duration}",
            f"[dim]Tokens: {tokens:,}[/dim]",
            "─" * 25,
            f"[dim]{bar}[/dim] {progress}%"
        ]

        # Add output preview (last 2 lines)
        output = self.worker_data.get("output_preview", [])
        if output:
            lines.append("[dim]" + "\n".join(output[-2:]) + "[/dim]")

        return "\n".join(lines)


class WorkerGridPanel(Static):
    """
    Grid panel containing worker cards.

    Layout: 2x2 grid of workers (expandable to 3x3 or 4x4)
    """

    workers: reactive[List[Dict[str, Any]]] = reactive([])
    selected_index: reactive[int] = reactive(0)

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self.id = "worker_grid"
        self.task_queue = TaskQueue()
        self.grid_size = (2, 2)  # rows, cols

    def compose(self):
        """Create grid of worker cards."""
        with Grid(id="worker_grid_container"):
            # Create 2x2 grid (4 worker slots)
            for i in range(self.grid_size[0] * self.grid_size[1]):
                yield WorkerCard(id=f"worker_card_{i}")

    async def update_workers(self) -> None:
        """Update worker data from task queue."""
        try:
            # Get in-progress tasks
            in_progress = self.task_queue.list_tasks(TaskStatus.IN_PROGRESS)

            # Get assigned tasks
            assigned = self.task_queue.list_tasks(TaskStatus.ASSIGNED)

            # Combine and format
            workers = []
            for task in (in_progress + assigned)[:4]:  # Max 4 workers in 2x2 grid
                worker = {
                    "id": task.get("task_id"),
                    "task_title": task.get("task_title", "Unknown"),
                    "status": task.get("status"),
                    "duration": self._calculate_duration(task),
                    "tokens_used": 0,  # TODO: Track tokens
                    "progress": 50,  # TODO: Calculate actual progress
                    "output_preview": []  # TODO: Tail log file
                }
                workers.append(worker)

            self.workers = workers

            # Update worker cards
            cards = self.query(WorkerCard)
            for i, card in enumerate(cards):
                if i < len(workers):
                    card.worker_data = workers[i]
                    card.remove_class("idle", "active", "assigned", "completed", "failed")
                    card.add_class(workers[i]["status"].lower())
                else:
                    card.worker_data = {"status": "idle"}
                    card.remove_class("idle", "active", "assigned", "completed", "failed")
                    card.add_class("idle")
                card.refresh()

        except Exception as e:
            self.app.notify(f"Error updating workers: {e}", severity="error")

    def _calculate_duration(self, task: Dict) -> str:
        """Calculate task duration."""
        from datetime import datetime
        started_at = task.get("started_at") or task.get("assigned_at")
        if not started_at:
            return "0s"

        try:
            start = datetime.fromisoformat(started_at.replace("Z", ""))
            now = datetime.utcnow()
            delta = now - start
            minutes = int(delta.total_seconds() / 60)
            seconds = int(delta.total_seconds() % 60)
            return f"{minutes}m {seconds}s"
        except:
            return "0s"

    async def navigate(self, direction: str) -> None:
        """Navigate grid with arrow keys."""
        # TODO: Implement grid navigation
        pass

    def get_selected_worker(self) -> Optional[Dict[str, Any]]:
        """Get currently selected worker."""
        if 0 <= self.selected_index < len(self.workers):
            return self.workers[self.selected_index]
        return None
