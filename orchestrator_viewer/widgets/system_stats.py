"""
System Statistics Panel

Displays:
- Task queue status (queued, in-progress, completed, failed)
- Worker status (active, idle, stalled)
- Token usage (per-CLI aggregated)
- Memory/RAG statistics
- GPU utilization (if available)
"""

import os
from pathlib import Path
from typing import Dict, Any

from textual.widgets import Static
from textual.reactive import reactive

# Import task queue
import sys
sys.path.insert(0, str(Path(__file__).parent.parent.parent))
from shared.task_queue import TaskQueue, TaskStatus


class SystemStatsPanel(Static):
    """
    System-wide statistics panel.

    Updates every 2 seconds with:
    - Task queue metrics
    - Worker health
    - Resource usage
    """

    stats_data: reactive[Dict[str, Any]] = reactive({})

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self.id = "system_stats"
        self.task_queue = TaskQueue()

    def render(self) -> str:
        """Render statistics as formatted text."""
        if not self.stats_data:
            return "[dim]Loading statistics...[/dim]"

        queue = self.stats_data.get("queue", {})
        workers = self.stats_data.get("workers", {})
        tokens = self.stats_data.get("tokens", {})
        memory = self.stats_data.get("memory", {})
        gpu = self.stats_data.get("gpu", {})

        lines = []

        # Title
        lines.append("[bold cyan]═══ System Stats ═══[/bold cyan]")

        # Queue statistics
        queued = queue.get("queued", 0)
        in_progress = queue.get("in_progress", 0)
        completed = queue.get("completed", 0)
        failed = queue.get("failed", 0)

        queue_color = "green" if queued == 0 and in_progress == 0 else "yellow" if queued < 5 else "red"
        lines.append(
            f"[dim]Queue:[/dim] "
            f"[{queue_color}]{queued}[/{queue_color}] queued │ "
            f"[yellow]{in_progress}[/yellow] in-progress │ "
            f"[green]{completed}[/green] completed │ "
            f"[red]{failed}[/red] failed"
        )

        # Worker statistics
        active = workers.get("active", 0)
        idle = workers.get("idle", 0)
        stalled = workers.get("stalled", 0)

        worker_color = "green" if active > 0 else "dim"
        lines.append(
            f"[dim]Workers:[/dim] "
            f"[{worker_color}]{active}[/{worker_color}] active │ "
            f"[dim]{idle}[/dim] idle │ "
            f"[red]{stalled}[/red] stalled"
        )

        # Token usage (if available)
        if tokens:
            used = tokens.get("used", 0)
            remaining = tokens.get("remaining", 0)
            limit = tokens.get("limit", 0)
            provider = tokens.get("provider", "Unknown")

            usage_pct = (used / limit * 100) if limit > 0 else 0
            token_color = "green" if usage_pct < 50 else "yellow" if usage_pct < 80 else "red"

            lines.append(
                f"[dim]Tokens:[/dim] "
                f"[{token_color}]{used:,}[/{token_color}] used │ "
                f"[green]{remaining:,}[/green] remaining "
                f"[dim]({provider}: {limit:,} daily)[/dim]"
            )

        # Memory/RAG statistics (if available)
        if memory:
            items = memory.get("items", 0)
            categories = memory.get("categories", 0)
            hits = memory.get("hits", 0)

            lines.append(
                f"[dim]Memory:[/dim] "
                f"[cyan]{items:,}[/cyan] items │ "
                f"[cyan]{categories}[/cyan] categories │ "
                f"[green]{hits}[/green] hits (last hour)"
            )

        # GPU statistics (if available)
        if gpu:
            util = gpu.get("utilization", 0)
            vram = gpu.get("vram_used", 0)
            model = gpu.get("model", "None")

            util_color = "green" if util < 70 else "yellow" if util < 90 else "red"
            lines.append(
                f"[dim]GPU:[/dim] "
                f"RTX 5090 │ "
                f"[{util_color}]{util}%[/{util_color}] util │ "
                f"[cyan]{vram:.1f}GB[/cyan] VRAM │ "
                f"Model: [magenta]{model}[/magenta]"
            )

        return "\n".join(lines)

    async def update_stats(self) -> None:
        """Update statistics from various sources."""
        stats = {}

        # Get queue statistics
        try:
            queue_stats = self.task_queue.get_queue_stats()
            stats["queue"] = queue_stats
        except Exception as e:
            stats["queue"] = {"error": str(e)}

        # Get worker statistics (placeholder - will implement when workers exist)
        # For now, infer from task queue
        active_count = queue_stats.get(TaskStatus.IN_PROGRESS.value, 0)
        stats["workers"] = {
            "active": active_count,
            "idle": 0,  # TODO: Track idle workers
            "stalled": 0  # TODO: Implement stale task detection
        }

        # Token usage (placeholder - will implement with CLI tracking)
        stats["tokens"] = {
            "used": 0,  # TODO: Track actual usage
            "remaining": 1000000,  # Example
            "limit": 1000000,
            "provider": "Claude"
        }

        # Memory statistics (placeholder - will implement with memory system)
        stats["memory"] = {
            "items": 0,  # TODO: Query PostgreSQL memory_items table
            "categories": 0,
            "hits": 0
        }

        # GPU statistics (placeholder - will implement with GPU monitoring)
        stats["gpu"] = {
            "utilization": 0,  # TODO: Query nvidia-smi or similar
            "vram_used": 0.0,
            "model": "None loaded"
        }

        # Update reactive property (triggers re-render)
        self.stats_data = stats
