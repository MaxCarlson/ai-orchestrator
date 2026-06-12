from shared.task_queue import TaskQueue, TaskStatus


def test_update_priority_updates_queued_task(tmp_path):
    queue = TaskQueue(queue_path=str(tmp_path))
    task_id = queue.create_task(
        project_id="project-1",
        task_title="Index project",
        description="Run embeddings",
        priority=3,
        cli_preference="local",
        context={"job_type": "index_repo"},
    )

    updated = queue.update_priority(task_id, 5)

    assert updated is not None
    assert updated["priority"] == 5
    queued = queue.get_task(task_id, TaskStatus.QUEUED)
    assert queued is not None
    assert queued["priority"] == 5
    assert queued["priority_updated_at"]


def test_cancel_task_moves_task_to_failed_with_cancelled_error(tmp_path):
    queue = TaskQueue(queue_path=str(tmp_path))
    task_id = queue.create_task(
        project_id="project-1",
        task_title="Index project",
        description="Run embeddings",
        cli_preference="local",
    )

    cancelled = queue.cancel_task(task_id, reason="Need GPU free", cancelled_by="test")

    assert cancelled is not None
    assert queue.get_task(task_id, TaskStatus.QUEUED) is None
    failed = queue.get_task(task_id, TaskStatus.FAILED)
    assert failed is not None
    assert failed["error"]["type"] == "Cancelled"
    assert failed["error"]["message"] == "Need GPU free"
    assert failed["error"]["cancelled_by"] == "test"


def test_cancel_matching_filters_local_embedding_jobs(tmp_path):
    queue = TaskQueue(queue_path=str(tmp_path))
    local_embedding_id = queue.create_task(
        project_id="project-1",
        task_title="Index project",
        description="Run embeddings",
        cli_preference="local",
        context={"job_type": "index_repo"},
    )
    queue.create_task(
        project_id="project-1",
        task_title="Claude work",
        description="Do work",
        cli_preference="claude",
        context={"job_type": "agent_task"},
    )

    cancelled = queue.cancel_matching(cli_preference="local", job_types={"index_repo"})

    assert [task["task_id"] for task in cancelled] == [local_embedding_id]
    assert queue.get_task(local_embedding_id, TaskStatus.FAILED) is not None
    assert len(queue.list_tasks(TaskStatus.QUEUED)) == 1
