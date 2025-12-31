"""
Quick test script for task queue manager.
Run with: python shared/test_task_queue.py
"""

import sys
import tempfile
from pathlib import Path

# Add parent directory to path for imports
sys.path.insert(0, str(Path(__file__).parent.parent))

from shared.task_queue import TaskQueue, TaskStatus, TaskPriority


def test_task_lifecycle():
    """Test complete task lifecycle."""
    print("🧪 Testing Task Queue Manager\n")

    # Create temp directory for testing
    with tempfile.TemporaryDirectory() as tmpdir:
        queue = TaskQueue(queue_path=tmpdir)
        print(f"✅ Task queue initialized at {tmpdir}\n")

        # Test 1: Create task
        print("Test 1: Create and submit task")
        task_id = queue.create_task(
            project_id="test-project-123",
            task_title="Test task",
            description="This is a test task",
            priority=TaskPriority.HIGH,
            cli_preference="claude"
        )
        print(f"  ✅ Task created: {task_id}")

        # Verify it's in queued/
        task = queue.get_task(task_id, TaskStatus.QUEUED)
        assert task is not None, "Task not found in queued/"
        assert task["task_title"] == "Test task"
        print(f"  ✅ Task found in queued/\n")

        # Test 2: Assign task
        print("Test 2: Assign task to CLI worker")
        success = queue.assign_task(task_id, assigned_to="claude-code", worker_pid=12345)
        assert success, "Task assignment failed"
        print(f"  ✅ Task assigned to claude-code\n")

        # Verify it moved to assigned/
        task = queue.get_task(task_id, TaskStatus.ASSIGNED)
        assert task is not None, "Task not found in assigned/"
        assert task["assigned_to"] == "claude-code"
        print(f"  ✅ Task found in assigned/\n")

        # Test 3: Start task
        print("Test 3: Start task execution")
        success = queue.start_task(task_id)
        assert success, "Task start failed"
        print(f"  ✅ Task started\n")

        # Verify it moved to in_progress/
        task = queue.get_task(task_id, TaskStatus.IN_PROGRESS)
        assert task is not None, "Task not found in in_progress/"
        print(f"  ✅ Task found in in_progress/\n")

        # Test 4: Update heartbeat
        print("Test 4: Update task heartbeat")
        success = queue.update_heartbeat(task_id)
        assert success, "Heartbeat update failed"
        print(f"  ✅ Heartbeat updated\n")

        # Test 5: Complete task
        print("Test 5: Complete task with results")
        success = queue.complete_task(
            task_id,
            result={
                "success": True,
                "summary": "Task completed successfully",
                "files_modified": 3
            }
        )
        assert success, "Task completion failed"
        print(f"  ✅ Task completed\n")

        # Verify it moved to completed/
        task = queue.get_task(task_id, TaskStatus.COMPLETED)
        assert task is not None, "Task not found in completed/"
        assert task["result"]["success"] is True
        print(f"  ✅ Task found in completed/\n")

        # Test 6: Queue stats
        print("Test 6: Get queue statistics")
        stats = queue.get_queue_stats()
        print(f"  Queue stats: {stats}")
        assert stats[TaskStatus.COMPLETED.value] == 1
        print(f"  ✅ Stats correct\n")

        # Test 7: Fail a task
        print("Test 7: Create and fail a task")
        task_id2 = queue.create_task(
            project_id="test-project-123",
            task_title="Failing task",
            description="This task will fail"
        )
        queue.assign_task(task_id2, assigned_to="claude-code")
        queue.start_task(task_id2)
        success = queue.fail_task(
            task_id2,
            error={
                "type": "TestError",
                "message": "Intentional test failure"
            },
            exit_code=1
        )
        assert success, "Task failure handling failed"
        print(f"  ✅ Task failed successfully\n")

        # Verify it moved to failed/
        task = queue.get_task(task_id2, TaskStatus.FAILED)
        assert task is not None, "Task not found in failed/"
        assert task["error"]["type"] == "TestError"
        print(f"  ✅ Task found in failed/\n")

        # Test 8: List tasks
        print("Test 8: List tasks by status")
        completed_tasks = queue.list_tasks(TaskStatus.COMPLETED)
        failed_tasks = queue.list_tasks(TaskStatus.FAILED)
        print(f"  Completed: {len(completed_tasks)}, Failed: {len(failed_tasks)}")
        assert len(completed_tasks) == 1
        assert len(failed_tasks) == 1
        print(f"  ✅ Task listing works\n")

        print("=" * 50)
        print("🎉 All tests passed!")
        print("=" * 50)


if __name__ == "__main__":
    test_task_lifecycle()
