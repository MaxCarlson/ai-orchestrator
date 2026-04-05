from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "orchestrator_web_viewer"))

from orchestrator_web_viewer.api.system_stats import _parse_gpu_inventory_output


def test_parse_gpu_inventory_output_returns_named_devices():
    payload = """
    0, NVIDIA RTX 5090, 32768
    1, NVIDIA RTX 4090, 24564
    """

    parsed = _parse_gpu_inventory_output(payload)

    assert parsed == [
        {"index": 0, "name": "NVIDIA RTX 5090", "memory_total_mb": 32768},
        {"index": 1, "name": "NVIDIA RTX 4090", "memory_total_mb": 24564},
    ]


def test_parse_gpu_inventory_output_skips_invalid_rows():
    payload = """
    not-a-row
    0, NVIDIA RTX 5090, 32768
    1, Broken, unknown
    """

    parsed = _parse_gpu_inventory_output(payload)

    assert parsed == [
        {"index": 0, "name": "NVIDIA RTX 5090", "memory_total_mb": 32768},
        {"index": 1, "name": "Broken", "memory_total_mb": None},
    ]
