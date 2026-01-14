"""
Vector-only code search against code_chunks.
"""

from __future__ import annotations

from typing import Any, Dict, List

import asyncpg
import numpy as np


async def search_code(
    conn: asyncpg.Connection,
    project_id: str,
    query_embedding: np.ndarray,
    top_k: int = 20,
) -> List[Dict[str, Any]]:
    rows = await conn.fetch(
        """
        SELECT
            file_path,
            symbol_name,
            chunk_type,
            start_line,
            end_line,
            content,
            1 - (embedding <=> $1) AS similarity
        FROM code_chunks
        WHERE project_id = $2 AND embedding_status = 'ready'
        ORDER BY embedding <=> $1
        LIMIT $3
        """,
        query_embedding,
        project_id,
        top_k,
    )
    return [dict(row) for row in rows]
