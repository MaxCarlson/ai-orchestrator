"""
Document loading utilities using LangChain for the text RAG pipeline.

Wraps LangChain's DirectoryLoader, TextLoader, and UnstructuredPDFLoader
to produce LangChain Document objects with consistent source_type metadata
attached. Only plain-text and PDF files are handled here; code files are
excluded and handled by the existing AST-based code indexer.
"""

from __future__ import annotations

import logging
from pathlib import Path

from langchain_community.document_loaders import DirectoryLoader, TextLoader
from langchain_core.documents import Document


logger = logging.getLogger(__name__)

# File extensions routed to the text pipeline
TEXT_EXTENSIONS: frozenset[str] = frozenset({".md", ".txt", ".rst", ".markdown"})
PDF_EXTENSIONS: frozenset[str] = frozenset({".pdf"})

# File extensions excluded from text loading (handled by code pipeline or ignored)
CODE_EXTENSIONS: frozenset[str] = frozenset({
    ".py", ".js", ".ts", ".jsx", ".tsx", ".go", ".rs", ".java",
    ".c", ".cpp", ".h", ".cs", ".rb", ".php", ".swift", ".kt",
})


def load_text_documents(path: Path) -> list[Document]:
    """Load plain-text and markdown documents from a directory tree.

    Recursively scans *path* for files with extensions in TEXT_EXTENSIONS.
    Each file is loaded as a LangChain Document with ``source_type``
    metadata set to ``'file'``.

    Args:
        path: Root directory to scan.

    Returns:
        List of Document objects with page_content and metadata.
        metadata keys: source (absolute file path str), source_type ('file').
    """
    if not path.exists():
        raise FileNotFoundError(f"Document path not found: {path}")

    docs: list[Document] = []
    for ext in TEXT_EXTENSIONS:
        glob = f"**/*{ext}"
        try:
            loader = DirectoryLoader(
                str(path),
                glob=glob,
                loader_cls=TextLoader,
                loader_kwargs={"encoding": "utf-8"},
                silent_errors=True,
            )
            loaded = loader.load()
            for doc in loaded:
                doc.metadata["source_type"] = "file"
            docs.extend(loaded)
        except Exception:
            logger.warning("Failed to load documents with glob %s from %s", glob, path, exc_info=True)
    logger.info("Loaded %d text/markdown documents from %s", len(docs), path)
    return docs


def load_pdf_documents(path: Path) -> list[Document]:
    """Load PDF documents from a directory tree, converting pages to text.

    Recursively scans *path* for ``.pdf`` files using
    UnstructuredPDFLoader. Each document gets ``source_type`` metadata
    set to ``'pdf'``. Requires ``unstructured`` package.

    Args:
        path: Root directory to scan.

    Returns:
        List of Document objects. metadata keys: source, source_type ('pdf').
    """
    try:
        import unstructured  # noqa: F401  # Check availability before proceeding
    except ImportError:
        logger.warning("unstructured package not installed; PDF loading disabled")
        return []

    from langchain_community.document_loaders import UnstructuredPDFLoader

    docs: list[Document] = []
    for pdf_path in path.rglob("*.pdf"):
        try:
            loader = UnstructuredPDFLoader(str(pdf_path))
            loaded = loader.load()
            for doc in loaded:
                doc.metadata["source_type"] = "pdf"
                doc.metadata["source"] = str(pdf_path)
            docs.extend(loaded)
        except Exception:
            logger.warning("Failed to load PDF %s", pdf_path, exc_info=True)
    logger.info("Loaded %d PDF documents from %s", len(docs), path)
    return docs


def load_all_documents(path: Path, include_pdfs: bool = True) -> list[Document]:
    """Load all supported documents (text, markdown, optionally PDF).

    Combines load_text_documents() and optionally load_pdf_documents()
    into a single pass over *path*.

    Args:
        path: Root directory to scan.
        include_pdfs: Whether to include PDF files.

    Returns:
        Combined list of Documents from all supported file types.
    """
    docs = load_text_documents(path)
    if include_pdfs:
        docs.extend(load_pdf_documents(path))
    return docs


def load_raw_text(text: str, source_label: str, metadata: dict | None = None) -> Document:
    """Wrap raw text as a LangChain Document for API-submitted content.

    Args:
        text: The raw text content to wrap.
        source_label: A label used as the source path (e.g. 'note-2026-04-02').

    Returns:
        A single Document with source_type 'api_direct'.
    """
    merged_metadata = {"source": source_label, "source_type": "api_direct"}
    if metadata:
        merged_metadata.update(metadata)
    return Document(page_content=text, metadata=merged_metadata)
