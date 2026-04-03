from memory import retrieval


def test_invalidate_bm25_cache_for_specific_scope():
    retrieval._bm25_cache.clear()
    retrieval._bm25_cache[("text_chunks", "project_id", "p1")] = (0.0, object(), [])
    retrieval._bm25_cache[("global_text_chunks", "source_key", "p1")] = (0.0, object(), [])

    retrieval.invalidate_bm25_cache("text_chunks", "project_id", "p1")

    assert ("text_chunks", "project_id", "p1") not in retrieval._bm25_cache
    assert ("global_text_chunks", "source_key", "p1") in retrieval._bm25_cache


def test_invalidate_bm25_cache_backward_compatible_by_owner():
    retrieval._bm25_cache.clear()
    retrieval._bm25_cache[("text_chunks", "project_id", "p1")] = (0.0, object(), [])
    retrieval._bm25_cache[("global_text_chunks", "source_key", "p1")] = (0.0, object(), [])

    retrieval.invalidate_bm25_cache(owner_id="p1")

    assert not retrieval._bm25_cache
