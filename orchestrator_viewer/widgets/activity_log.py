"""
Activity Log Panel

Displays recent orchestrator events:
- Task state changes
- Worker spawns/exits
- Memory operations
- Errors and warnings
"""

from datetime import datetime
from typing import List, Dict, Any
from pathlib import Path

from textual.widgets import Static, RichLog
from textual.reactive import reactive

import sys
sys.path.insert(0, str(Path(__file__).parent.parent.parent))
from shared.task_queue import TaskQueue, TaskStatus


class ActivityLogPanel(Static):
    """
    Activity log showing recent orchestrator events.

    Automatically scrolls to show latest activity.
    """

    activities: reactive[List[Dict[str, Any]]] = reactive([])

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self.id = "activity_log"
        self.task_queue = TaskQueue()
        self.max_activities = 10

    def compose(self):
        """Create rich log widget."""
        yield RichLog(id="activity_log_content", max_lines=self.max_activities, wrap=True)

    async def update_activities(self) -> None:
        """Update activity log from task queue."""
        try:
            activities = []

            # Get recently completed tasks
            completed = self.task_queue.list_tasks(TaskStatus.COMPLETED, limit=3)
            for task in completed:
                activities.append({
                    "time": task.get("completed_at", ""),
                    "type": "task_completed",
                    "message": f"Task {task['task_id'][:8]} completed (duration: {task.get('duration_seconds', 0)}s)",
                    "color": "green"
                })

            # Get failed tasks
            failed = self.task_queue.list_tasks(TaskStatus.FAILED, limit=2)
            for task in failed:
                activities.append({
                    "time": task.get("failed_at", ""),
                    "type": "task_failed",
                    "message": f"Task {task['task_id'][:8]} failed: {task.get('error', {}).get('message', 'Unknown error')}",
                    "color": "red"
                })

            # Get in-progress tasks
            in_progress = self.task_queue.list_tasks(TaskStatus.IN_PROGRESS, limit=2)
            for task in in_progress:
                activities.append({
                    "time": task.get("started_at", ""),
                    "type": "task_started",
                    "message": f"Task {task['task_id'][:8]} started: {task.get('task_title', 'Unknown')}",
                    "color": "yellow"
                })

            # Sort by time (most recent first)
            activities.sort(key=lambda x: x.get("time", ""), reverse=True)

            self.activities = activities[:self.max_activities]

            # Update rich log
            log = self.query_one("#activity_log_content", RichLog)
            log.clear()
            log.write("[bold cyan]═══ Recent Activity ═══[/bold cyan]")

            for activity in self.activities:
                time_str = self._format_time(activity.get("time", ""))
                color = activity.get("color", "white")
                message = activity.get("message", "")

                log.write(f"[dim]{time_str}[/dim]  [{color}]{message}[/{color}]")

            if not activities:
                log.write("[dim]No recent activity[/dim]")

        except Exception as e:
            self.app.notify(f"Error updating activity log: {e}", severity="error")

    def _format_time(self, time_str: str) -> str:
        """Format ISO timestamp to HH:MM:SS."""
        if not time_str:
            return "00:00:00"

        try:
            dt = datetime.fromisoformat(time_str.replace("Z", ""))
            return dt.strftime("%H:%M:%S")
        except:
            return "00:00:00"
