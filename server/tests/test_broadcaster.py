"""Tests de `JobBroadcaster` et de `ProgressThrottle`."""

from __future__ import annotations

from app.core.broadcaster import JobBroadcaster
from app.core.progress import ProgressThrottle
from app.models import Job, JobStatus
from app.schemas import JobOut


def _job(progress: float = 0.0) -> Job:
    return Job(url="https://example.com/v", folder="/mnt/media/movies", progress=progress)


def test_publish_sends_a_snapshot_not_the_live_object() -> None:
    broadcaster = JobBroadcaster()
    queue = broadcaster.subscribe()
    job = _job(10.0)

    broadcaster.publish(job)
    job.progress = 99.0  # mutation postérieure par la mise à jour suivante

    snapshot = queue.get_nowait()
    assert isinstance(snapshot, JobOut)
    assert snapshot.progress == 10.0


def test_subscriber_queue_is_bounded_and_drops_the_oldest() -> None:
    broadcaster = JobBroadcaster(queue_size=3)
    queue = broadcaster.subscribe()

    for step in range(10):
        broadcaster.publish(_job(float(step)))

    assert queue.qsize() == 3
    assert [queue.get_nowait().progress for _ in range(3)] == [7.0, 8.0, 9.0]


def test_unsubscribed_queue_receives_nothing() -> None:
    broadcaster = JobBroadcaster()
    queue = broadcaster.subscribe()
    broadcaster.unsubscribe(queue)

    broadcaster.publish(_job())

    assert queue.empty()
    assert JobStatus.QUEUED.value == _job().status


def test_throttle_lets_one_write_through_per_interval() -> None:
    now = [0.0]
    throttle = ProgressThrottle(interval=0.5, clock=lambda: now[0])

    assert throttle.should_emit() is True  # la toute première mesure passe toujours
    now[0] = 0.2
    assert throttle.should_emit() is False
    now[0] = 0.5
    assert throttle.should_emit() is True
    now[0] = 0.9
    assert throttle.should_emit() is False
