# Advanced Code-Aware Embedding & Vector Store Implementation Plan

**For: AI Orchestrator Project**  
**Date: January 2026**  
**Objective**: Enable intelligent code retrieval and context injection for LLM-driven task routing  
**Target Timeline**: 2-3 weeks (can be phased)

---

## Architecture Overview

Your enhanced embedding system will consist of 5 integrated layers:

```
REPOSITORIES (input)
  ↓
SEMANTIC PARSING (astchunk → AST chunks)
  ↓
DEPENDENCY ANALYSIS (build code graph, compute PageRank)
  ↓
EMBEDDING GENERATION (CodeBERT on RTX 5090 → 768-dim vectors)
  ↓
HYBRID STORAGE (PostgreSQL + pgvector + ParadeDB BM25)
  ↓
INTELLIGENT RETRIEVAL (RRF fusion: semantic + lexical + structural)
  ↓
CONTEXT INJECTION (augment task prompts with relevant code)
```

---

## Phase 1: AST-Based Code Chunking (Days 1-2)

### 1.1 Install Dependencies

```bash
# Add to memory/requirements.txt or docker/orchestrator/requirements.txt
astchunk>=0.3.0                    # CMU Research - AST chunking
tree-sitter-language-pack>=0.13.0  # 165+ language grammars
tree-sitter>=0.25.0                # AST parsing
networkx>=3.2                       # Dependency graph + PageRank
```

### 1.2 Create AST Chunker Module

**File**: `memory/code_chunker.py`

```python
"""AST-based semantic code chunking."""

import ast
import hashlib
import logging
from typing import Dict, List, Optional, Tuple
from pathlib import Path
from dataclasses import dataclass

import astchunk
import tree_sitter
from tree_sitter_language_pack import get_parser

logger = logging.getLogger(__name__)

@dataclass
class CodeChunk:
    """Represents a semantically meaningful code segment."""
    content: str
    file_path: str
    symbol_name: Optional[str]  # function/class name
    chunk_type: str  # 'function', 'class', 'module', 'block'
    start_line: int
    end_line: int
    language: str
    content_hash: str
    metadata: Dict  # Additional context
    
    def __post_init__(self):
        """Compute content hash."""
        if not self.content_hash:
            self.content_hash = hashlib.sha256(
                self.content.encode()
            ).hexdigest()


class ASTCodeChunker:
    """Chunk code using AST-based semantic boundaries."""
    
    LANGUAGE_EXTENSIONS = {
        'python': {'.py'},
        'typescript': {'.ts', '.tsx'},
        'javascript': {'.js', '.jsx'},
        'java': {'.java'},
        'csharp': {'.cs'},
    }
    
    def __init__(self, max_chunk_size: int = 1024, overlap: int = 128):
        """
        Args:
            max_chunk_size: Maximum tokens per chunk
            overlap: Overlapping tokens between chunks
        """
        self.max_chunk_size = max_chunk_size
        self.overlap = overlap
        self.astchunk_chunker = astchunk.ASTChunker(
            max_chunk_size=max_chunk_size,
            overlap=overlap
        )
    
    def detect_language(self, file_path: str) -> str:
        """Infer language from file extension."""
        suffix = Path(file_path).suffix.lower()
        for lang, extensions in self.LANGUAGE_EXTENSIONS.items():
            if suffix in extensions:
                return lang
        return None
    
    def chunk_file(self, file_path: str) -> List[CodeChunk]:
        """
        Parse and chunk a single source file.
        
        Returns:
            List of CodeChunk objects with semantic boundaries preserved
        """
        try:
            with open(file_path, 'r', encoding='utf-8') as f:
                content = f.read()
        except Exception as e:
            logger.warning(f"Failed to read {file_path}: {e}")
            return []
        
        language = self.detect_language(file_path)
        if not language:
            logger.debug(f"Unsupported language for {file_path}, using tree-sitter fallback")
            return self._chunk_with_tree_sitter(file_path, content)
        
        # Use astchunk for supported languages
        return self._chunk_with_astchunk(file_path, content, language)
    
    def _chunk_with_astchunk(
        self,
        file_path: str,
        content: str,
        language: str
    ) -> List[CodeChunk]:
        """Chunk using astchunk library."""
        try:
            raw_chunks = self.astchunk_chunker.chunk(
                content,
                language=language
            )
        except Exception as e:
            logger.error(f"astchunk failed for {file_path}: {e}, falling back")
            return self._chunk_fallback(file_path, content)
        
        chunks = []
        for raw in raw_chunks:
            # raw = {'content': str, 'metadata': {start_line, end_line, node_type, ...}}
            metadata = raw.get('metadata', {})
            
            chunk = CodeChunk(
                content=raw['content'],
                file_path=file_path,
                symbol_name=metadata.get('symbol_name'),
                chunk_type=metadata.get('node_type', 'block'),
                start_line=metadata.get('start_line', 0),
                end_line=metadata.get('end_line', 0),
                language=language,
                content_hash='',  # Computed in __post_init__
                metadata={
                    'docstring': metadata.get('docstring'),
                    'parent_type': metadata.get('parent_type'),
                    'imports': self._extract_imports(raw['content']),
                }
            )
            chunks.append(chunk)
        
        return chunks
    
    def _chunk_with_tree_sitter(
        self,
        file_path: str,
        content: str
    ) -> List[CodeChunk]:
        """Fallback: Use tree-sitter for unsupported languages."""
        try:
            language = self.detect_language(file_path)
            parser = get_parser(language)
            tree = parser.parse(content.encode())
            
            # Simple approach: chunk by top-level definitions
            chunks = self._extract_definitions_from_tree(
                file_path, content, tree, language
            )
            return chunks
        except Exception as e:
            logger.warning(f"tree-sitter failed for {file_path}, using fallback")
            return self._chunk_fallback(file_path, content)
    
    def _chunk_fallback(self, file_path: str, content: str) -> List[CodeChunk]:
        """Last resort: Chunk by fixed size with line-boundary preservation."""
        chunks = []
        lines = content.split('\n')
        
        for start_idx in range(0, len(lines), self.max_chunk_size):
            end_idx = min(start_idx + self.max_chunk_size, len(lines))
            chunk_lines = lines[start_idx:end_idx]
            chunk_content = '\n'.join(chunk_lines)
            
            chunk = CodeChunk(
                content=chunk_content,
                file_path=file_path,
                symbol_name=None,
                chunk_type='block',
                start_line=start_idx + 1,
                end_line=end_idx,
                language='unknown',
                content_hash='',
                metadata={}
            )
            chunks.append(chunk)
        
        return chunks
    
    def _extract_imports(self, code: str) -> List[str]:
        """Extract import statements for context."""
        imports = []
        try:
            tree = ast.parse(code)
            for node in ast.walk(tree):
                if isinstance(node, ast.Import):
                    for alias in node.names:
                        imports.append(alias.name)
                elif isinstance(node, ast.ImportFrom):
                    imports.append(f"from {node.module} import ...")
        except:
            pass
        return imports
    
    def _extract_definitions_from_tree(
        self,
        file_path: str,
        content: str,
        tree: tree_sitter.Tree,
        language: str
    ) -> List[CodeChunk]:
        """Extract function/class definitions from tree-sitter AST."""
        # Implementation: walk tree, find definitions, extract byte ranges
        # This is language-specific, simplified here
        chunks = []
        
        def walk(node, start_byte=0):
            if language == 'python' and node.type in ('function_definition', 'class_definition'):
                start_line = node.start_point[0] + 1
                end_line = node.end_point[0] + 1
                
                chunk_text = content[node.start_byte:node.end_byte].decode('utf-8')
                symbol_name = None
                for child in node.children:
                    if child.type == 'identifier':
                        symbol_name = child.text.decode('utf-8')
                        break
                
                chunks.append(CodeChunk(
                    content=chunk_text,
                    file_path=file_path,
                    symbol_name=symbol_name,
                    chunk_type='function' if node.type == 'function_definition' else 'class',
                    start_line=start_line,
                    end_line=end_line,
                    language=language,
                    content_hash='',
                    metadata={}
                ))
            
            for child in node.children:
                walk(child)
        
        walk(tree.root_node)
        return chunks
    
    def chunk_repository(self, repo_path: str) -> List[CodeChunk]:
        """
        Process entire repository, returning all chunks.
        
        Yields for large repos to avoid memory overflow.
        """
        repo_path = Path(repo_path)
        all_chunks = []
        
        # Find all source files
        for pattern in ['**/*.py', '**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx']:
            for file_path in repo_path.glob(pattern):
                # Skip common excluded directories
                if any(part.startswith('.') for part in file_path.parts):
                    continue
                if 'node_modules' in file_path.parts or 'venv' in file_path.parts:
                    continue
                
                chunks = self.chunk_file(str(file_path))
                all_chunks.extend(chunks)
                
                if len(all_chunks) > 10000:  # Prevent memory bloat
                    yield all_chunks
                    all_chunks = []
        
        if all_chunks:
            yield all_chunks


# Usage example
if __name__ == "__main__":
    chunker = ASTCodeChunker(max_chunk_size=1024, overlap=128)
    
    chunks = chunker.chunk_file("example.py")
    print(f"Generated {len(chunks)} chunks")
    
    for chunk in chunks[:3]:
        print(f"\n{chunk.symbol_name} ({chunk.chunk_type}):")
        print(chunk.content[:100] + "...")
```

### 1.3 Integration Test

**File**: `memory/test_chunker.py`

```python
"""Test code chunking."""

from pathlib import Path
from code_chunker import ASTCodeChunker

def test_chunk_python_file():
    chunker = ASTCodeChunker()
    
    # Create test file
    test_code = '''
def authenticate(username: str, password: str) -> bool:
    """Verify user credentials."""
    user = db.get_user(username)
    return user.verify_password(password)

class User:
    """User model."""
    def __init__(self, username: str):
        self.username = username
'''
    
    test_file = Path('/tmp/test.py')
    test_file.write_text(test_code)
    
    chunks = chunker.chunk_file(str(test_file))
    
    assert len(chunks) >= 2, "Should chunk function and class separately"
    assert any(c.chunk_type == 'function' for c in chunks), "Should detect function"
    assert any(c.chunk_type == 'class' for c in chunks), "Should detect class"
    
    print(f"✓ Test passed: {len(chunks)} chunks created")
    for chunk in chunks:
        print(f"  - {chunk.symbol_name or 'module'}: {chunk.chunk_type}")
```

---

## Phase 2: Dependency Graph & PageRank (Days 3-4)

### 2.1 Build Dependency Graph

**File**: `memory/dependency_graph.py`

```python
"""Build and analyze code dependency graphs."""

import ast
import logging
from typing import Dict, Set, List, Optional
from pathlib import Path
from collections import defaultdict

import networkx as nx

logger = logging.getLogger(__name__)


class DependencyGraphBuilder:
    """Extract dependencies and build importance graph."""
    
    def __init__(self):
        self.graph = nx.DiGraph()
        self.symbol_to_location = {}  # symbol_name → file:line
    
    def add_python_file(self, file_path: str):
        """Extract dependencies from a Python file."""
        try:
            with open(file_path, 'r') as f:
                tree = ast.parse(f.read())
        except Exception as e:
            logger.warning(f"Failed to parse {file_path}: {e}")
            return
        
        # Track top-level symbols in this file
        file_node = f"file:{file_path}"
        self.graph.add_node(file_node)
        
        for node in ast.walk(tree):
            # Track function definitions
            if isinstance(node, ast.FunctionDef):
                func_key = f"{file_path}:func:{node.name}:{node.lineno}"
                self.graph.add_node(func_key)
                self.graph.add_edge(file_node, func_key)  # File → function
                self.symbol_to_location[node.name] = func_key
            
            # Track class definitions
            elif isinstance(node, ast.ClassDef):
                class_key = f"{file_path}:class:{node.name}:{node.lineno}"
                self.graph.add_node(class_key)
                self.graph.add_edge(file_node, class_key)  # File → class
                self.symbol_to_location[node.name] = class_key
            
            # Track imports
            elif isinstance(node, ast.Import):
                for alias in node.names:
                    import_key = f"import:{alias.name}"
                    self.graph.add_node(import_key)
                    self.graph.add_edge(file_node, import_key)
            
            elif isinstance(node, ast.ImportFrom):
                for alias in node.names:
                    import_key = f"import:{node.module}:{alias.name}"
                    self.graph.add_node(import_key)
                    self.graph.add_edge(file_node, import_key)
            
            # Track function calls (dependencies between functions)
            elif isinstance(node, ast.Call):
                if isinstance(node.func, ast.Name):
                    caller = getattr(node, '_caller_key', None)
                    if node.func.id in self.symbol_to_location:
                        callee = self.symbol_to_location[node.func.id]
                        # Caller → Callee edge
                        if caller:
                            self.graph.add_edge(caller, callee)
    
    def add_repository(self, repo_path: str):
        """Process all Python files in repository."""
        repo_path = Path(repo_path)
        
        file_count = 0
        for py_file in repo_path.glob('**/*.py'):
            # Skip excluded directories
            if any(p.startswith('.') for p in py_file.relative_to(repo_path).parts):
                continue
            if 'venv' in py_file.parts or 'node_modules' in py_file.parts:
                continue
            
            self.add_python_file(str(py_file))
            file_count += 1
        
        logger.info(f"Added {file_count} Python files to dependency graph")
    
    def compute_pagerank(self, damping_factor: float = 0.85) -> Dict[str, float]:
        """
        Compute PageRank scores for all nodes.
        
        Higher score = more "important" (central, frequently used)
        """
        if self.graph.number_of_nodes() == 0:
            return {}
        
        pagerank = nx.pagerank(
            self.graph,
            alpha=damping_factor,
            max_iter=100,
            tol=1e-6
        )
        
        return pagerank
    
    def get_importance_score(self, symbol_key: str) -> float:
        """Get PageRank score (0.0 - 1.0) for a symbol."""
        pagerank = self.compute_pagerank()
        return pagerank.get(symbol_key, 0.0)
    
    def get_related_symbols(self, symbol_key: str, depth: int = 2) -> Set[str]:
        """Get symbols connected to target within N steps."""
        if symbol_key not in self.graph:
            return set()
        
        related = set()
        visited = set()
        queue = [(symbol_key, 0)]
        
        while queue:
            current, current_depth = queue.pop(0)
            if current in visited or current_depth > depth:
                continue
            
            visited.add(current)
            related.add(current)
            
            # Add neighbors
            for neighbor in self.graph.successors(current):
                if neighbor not in visited:
                    queue.append((neighbor, current_depth + 1))
            
            for neighbor in self.graph.predecessors(current):
                if neighbor not in visited:
                    queue.append((neighbor, current_depth + 1))
        
        return related - {symbol_key}
    
    def export_dot(self, output_path: str):
        """Export graph as DOT format (for visualization)."""
        nx.drawing.nx_agraph.write_dot(self.graph, output_path)


# Personalized PageRank for context-specific ranking
def personalized_pagerank(
    graph: nx.DiGraph,
    personalization: Dict[str, float],
    damping_factor: float = 0.85
) -> Dict[str, float]:
    """
    Compute PageRank with bias towards specific symbols.
    
    Useful for task-specific ranking:
    - Task about authentication → boost auth-related functions
    - Task about caching → boost cache-related functions
    """
    return nx.pagerank(
        graph,
        alpha=damping_factor,
        personalization=personalization,
        max_iter=100
    )


if __name__ == "__main__":
    # Example usage
    builder = DependencyGraphBuilder()
    builder.add_repository("/path/to/project")
    
    scores = builder.compute_pagerank()
    
    # Top 10 most important functions
    sorted_scores = sorted(scores.items(), key=lambda x: x[1], reverse=True)
    print("Top 10 most important symbols:")
    for symbol, score in sorted_scores[:10]:
        print(f"  {symbol}: {score:.4f}")
```

---

## Phase 3: Code-Specific Embeddings (Days 5-6)

### 3.1 Setup CodeBERT on GPU

**File**: `memory/code_embedder.py`

```python
"""Generate code-specific embeddings using CodeBERT."""

import logging
import numpy as np
from typing import List, Dict, Optional, Union
import torch
from sentence_transformers import SentenceTransformer

logger = logging.getLogger(__name__)


class CodeEmbedder:
    """Embed code chunks using CodeBERT."""
    
    # Embedding models (all 768-dimensional)
    MODELS = {
        'codebert': 'microsoft/codebert-base',  # Recommended
        'codebert-mlm': 'microsoft/codebert-base-mlm',
        'unixcoder': 'microsoft/unixcoder-base',
        'graphcodebert': 'microsoft/graphcodebert-base',
        'codesage-mini': 'codesage/codesage-small',  # Smaller, faster
        'bge-code': 'BAAI/bge-code-base-en-v1.5',  # Documentation-aware
    }
    
    def __init__(
        self,
        model_name: str = 'codebert',
        device: str = 'cuda',
        batch_size: int = 32,
        cache_path: Optional[str] = None
    ):
        """
        Args:
            model_name: Key from MODELS dict or HF model ID
            device: 'cuda' or 'cpu'
            batch_size: Process this many chunks at once
            cache_path: Cache directory for model downloads
        """
        self.device = device
        self.batch_size = batch_size
        
        # Resolve model name
        if model_name in self.MODELS:
            model_id = self.MODELS[model_name]
        else:
            model_id = model_name
        
        logger.info(f"Loading {model_id} on {device}...")
        
        self.model = SentenceTransformer(
            model_id,
            device=device,
            cache_folder=cache_path
        )
        
        # Verify dimensions
        if self.model.get_sentence_embedding_dimension() != 768:
            logger.warning(
                f"Model {model_id} has {self.model.get_sentence_embedding_dimension()} "
                f"dimensions, expected 768"
            )
        
        logger.info(f"Model loaded. Embedding dimension: 768")
    
    def embed_single(self, code: str) -> np.ndarray:
        """Embed a single code snippet."""
        embedding = self.model.encode(code, convert_to_numpy=True)
        return embedding  # shape: (768,)
    
    def embed_batch(
        self,
        code_list: List[str],
        show_progress: bool = True
    ) -> np.ndarray:
        """
        Embed multiple code snippets efficiently.
        
        Args:
            code_list: List of code strings
            show_progress: Show progress bar
        
        Returns:
            Array of shape (len(code_list), 768)
        """
        embeddings = self.model.encode(
            code_list,
            batch_size=self.batch_size,
            show_progress_bar=show_progress,
            convert_to_numpy=True
        )
        return embeddings  # shape: (n, 768)
    
    def embed_chunks(self, chunks: List[Dict]) -> List[Dict]:
        """
        Embed list of code chunks, adding 'embedding' field.
        
        Args:
            chunks: List of {content, metadata, ...} dicts
        
        Returns:
            Same list with 'embedding' field added
        """
        # Extract content
        contents = [chunk['content'] for chunk in chunks]
        
        # Embed in batch
        embeddings = self.embed_batch(contents)
        
        # Add embeddings to chunks
        for chunk, embedding in zip(chunks, embeddings):
            chunk['embedding'] = embedding
        
        return chunks
    
    def embed_with_context(
        self,
        code: str,
        docstring: Optional[str] = None,
        imports: Optional[List[str]] = None,
        augment_ratio: float = 0.2
    ) -> np.ndarray:
        """
        Embed code with optional contextual augmentation.
        
        Useful for embedding function/class definitions alongside
        their docstrings and imports.
        
        Args:
            code: Main code content
            docstring: Associated docstring/comments
            imports: Related import statements
            augment_ratio: Weight of augmentation (0.0-1.0)
        
        Returns:
            Enhanced embedding
        """
        # Embed main code
        main_embedding = self.embed_single(code)
        
        # If augmentation available, blend with it
        if docstring:
            doc_embedding = self.embed_single(docstring)
            # Blend: (1-ratio) * code + ratio * docstring
            main_embedding = (
                (1 - augment_ratio) * main_embedding +
                augment_ratio * doc_embedding
            )
        
        return main_embedding
    
    def similarity(
        self,
        embedding1: np.ndarray,
        embedding2: np.ndarray
    ) -> float:
        """
        Compute cosine similarity between two embeddings.
        
        Returns: float in [-1, 1]
        """
        from sklearn.metrics.pairwise import cosine_similarity
        
        sim = cosine_similarity(
            embedding1.reshape(1, -1),
            embedding2.reshape(1, -1)
        )[0, 0]
        
        return float(sim)


# Dual-model strategy for code + documentation
class DualEmbedder:
    """Embed code and documentation separately, then blend."""
    
    def __init__(self, device: str = 'cuda'):
        self.code_embedder = CodeEmbedder('codebert', device=device)
        self.doc_embedder = CodeEmbedder('bge-code', device=device)
    
    def embed_code_and_docs(
        self,
        code: str,
        documentation: str,
        code_weight: float = 0.8
    ) -> np.ndarray:
        """Blend code and documentation embeddings."""
        code_emb = self.code_embedder.embed_single(code)
        doc_emb = self.doc_embedder.embed_single(documentation)
        
        # Weighted average
        blended = (
            code_weight * code_emb +
            (1 - code_weight) * doc_emb
        )
        
        # Normalize
        blended = blended / np.linalg.norm(blended)
        
        return blended


if __name__ == "__main__":
    # Test embedding
    embedder = CodeEmbedder(device='cuda')
    
    test_code = """
def authenticate(username: str, password: str) -> bool:
    '''Verify user credentials against database.'''
    user = db.get_user(username)
    if not user:
        return False
    return user.verify_password(password)
"""
    
    embedding = embedder.embed_single(test_code)
    print(f"Embedding shape: {embedding.shape}")
    print(f"First 10 dims: {embedding[:10]}")
```

---

## Phase 4: Hybrid Storage in PostgreSQL (Days 7-9)

### 4.1 Schema Extensions

**File**: `docker/postgres/init-scripts/03_code_embeddings.sql`

```sql
-- Code chunks with embeddings
CREATE TABLE code_chunks (
    id SERIAL PRIMARY KEY,
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    file_path TEXT NOT NULL,
    
    -- Symbol identification
    symbol_name TEXT,  -- function/class name
    chunk_type TEXT,   -- 'function', 'class', 'module', 'block'
    
    -- Location in source
    start_line INTEGER,
    end_line INTEGER,
    
    -- Content and hash
    content TEXT NOT NULL,
    content_hash TEXT NOT NULL,  -- SHA256
    
    -- Embeddings (768 dimensions)
    embedding vector(768) NOT NULL,
    embedding_model TEXT DEFAULT 'microsoft/codebert-base',
    
    -- Structural importance
    pagerank_score FLOAT DEFAULT 0.0,
    
    -- Tracking
    language TEXT,
    git_commit TEXT,
    embedding_status TEXT DEFAULT 'pending',  -- pending, ready, error
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    
    -- Prevent duplicates
    UNIQUE(project_id, file_path, symbol_name)
);

-- Full-text search index (requires ParadeDB)
CREATE INDEX idx_code_chunks_bm25 ON code_chunks USING bm25 (content, symbol_name)
    WITH (tokenizer='default');

-- Vector similarity index (HNSW for speed)
CREATE INDEX idx_code_chunks_embedding ON code_chunks 
    USING hnsw (embedding vector_cosine_ops)
    WITH (m = 16, ef_construction = 200, ef = 100);

-- PageRank filtering
CREATE INDEX idx_code_chunks_pagerank ON code_chunks (pagerank_score DESC);

-- Status filtering
CREATE INDEX idx_code_chunks_status ON code_chunks (project_id, embedding_status);

-- Content hash for change detection
CREATE INDEX idx_code_chunks_hash ON code_chunks (content_hash);


-- Code dependencies (for PageRank)
CREATE TABLE code_dependencies (
    id SERIAL PRIMARY KEY,
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    
    source_file TEXT NOT NULL,  -- path/to/file.py
    source_symbol TEXT,         -- function/class name
    
    target_file TEXT NOT NULL,
    target_symbol TEXT,
    
    -- Dependency type
    dep_type TEXT,  -- 'call', 'import', 'inherit', 'reference'
    
    -- Strength/frequency
    weight FLOAT DEFAULT 1.0,
    
    created_at TIMESTAMP DEFAULT NOW(),
    
    UNIQUE(project_id, source_file, source_symbol, target_file, target_symbol)
);

-- Quick lookup of dependencies
CREATE INDEX idx_dependencies_source ON code_dependencies (project_id, source_file);
CREATE INDEX idx_dependencies_target ON code_dependencies (project_id, target_file);


-- Hybrid search results (cached for performance)
CREATE TABLE code_search_cache (
    id SERIAL PRIMARY KEY,
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    query_embedding vector(768) NOT NULL,
    query_text TEXT,
    
    -- Results stored as JSON for flexibility
    results JSONB NOT NULL,  -- [{chunk_id, score, rank}, ...]
    
    -- Cache lifetime
    created_at TIMESTAMP DEFAULT NOW(),
    expires_at TIMESTAMP DEFAULT NOW() + INTERVAL '24 hours',
    
    -- LRU tracking
    access_count INTEGER DEFAULT 1,
    last_accessed TIMESTAMP DEFAULT NOW()
);

-- Cleanup expired cache
CREATE INDEX idx_search_cache_expires ON code_search_cache (expires_at);


-- Track embedding status per project
ALTER TABLE project_tracking
ADD COLUMN code_embedding_status TEXT DEFAULT 'not_indexed',  -- not_indexed, indexing, ready, error
ADD COLUMN code_chunks_count INTEGER DEFAULT 0,
ADD COLUMN total_embedding_tokens BIGINT DEFAULT 0,
ADD COLUMN embedding_completion_percent FLOAT DEFAULT 0.0;
```

### 4.2 Hybrid Search Function

**File**: `docker/postgres/init-scripts/04_hybrid_search.sql`

```sql
-- Hybrid search function combining vector + BM25 + PageRank
CREATE OR REPLACE FUNCTION hybrid_code_search(
    p_project_id UUID,
    p_embedding vector(768),
    p_query_text TEXT DEFAULT NULL,
    p_semantic_weight FLOAT DEFAULT 1.0,
    p_lexical_weight FLOAT DEFAULT 1.0,
    p_structural_weight FLOAT DEFAULT 0.2,
    p_limit INT DEFAULT 20
)
RETURNS TABLE (
    chunk_id INT,
    symbol_name TEXT,
    file_path TEXT,
    similarity_score FLOAT,
    relevance_score FLOAT
) AS $$
WITH semantic_results AS (
    -- Vector similarity search
    SELECT 
        id,
        1.0 - (embedding <=> p_embedding) AS sim_score,
        ROW_NUMBER() OVER (ORDER BY embedding <=> p_embedding) AS sem_rank
    FROM code_chunks
    WHERE project_id = p_project_id AND embedding_status = 'ready'
    LIMIT p_limit * 3
),
lexical_results AS (
    -- BM25 keyword search (requires ParadeDB)
    SELECT
        id,
        pdb.score(id) AS bm25_score,
        ROW_NUMBER() OVER (ORDER BY pdb.score(id) DESC) AS lex_rank
    FROM code_chunks
    WHERE project_id = p_project_id 
        AND embedding_status = 'ready'
        AND (p_query_text IS NULL OR content @@ plainto_tsquery(p_query_text))
    LIMIT p_limit * 3
),
structural_results AS (
    -- PageRank-based importance
    SELECT
        id,
        pagerank_score / NULLIF(MAX(pagerank_score) OVER (), 0) AS norm_rank,
        ROW_NUMBER() OVER (ORDER BY pagerank_score DESC) AS struct_rank
    FROM code_chunks
    WHERE project_id = p_project_id AND embedding_status = 'ready'
    LIMIT p_limit * 3
),
ranked_fusion AS (
    -- Reciprocal Rank Fusion
    SELECT 
        COALESCE(sr.id, lr.id, str.id) AS chunk_id,
        (
            p_semantic_weight * COALESCE(1.0 / (60.0 + sr.sem_rank), 0) +
            p_lexical_weight * COALESCE(1.0 / (60.0 + lr.lex_rank), 0) +
            p_structural_weight * COALESCE(1.0 / (60.0 + str.struct_rank), 0)
        ) AS final_score,
        COALESCE(sr.sim_score, 0.0) AS sim_score
    FROM semantic_results sr
    FULL OUTER JOIN lexical_results lr ON sr.id = lr.id
    FULL OUTER JOIN structural_results str ON sr.id = str.id
)
SELECT
    rf.chunk_id,
    cc.symbol_name,
    cc.file_path,
    rf.sim_score::FLOAT,
    rf.final_score::FLOAT
FROM ranked_fusion rf
JOIN code_chunks cc ON rf.chunk_id = cc.id
ORDER BY rf.final_score DESC
LIMIT p_limit;
$$ LANGUAGE SQL STABLE;


-- Simpler vector-only search (fallback)
CREATE OR REPLACE FUNCTION vector_code_search(
    p_project_id UUID,
    p_embedding vector(768),
    p_limit INT DEFAULT 20
)
RETURNS TABLE (
    chunk_id INT,
    symbol_name TEXT,
    file_path TEXT,
    similarity FLOAT
) AS $$
SELECT
    id,
    symbol_name,
    file_path,
    (1.0 - (embedding <=> p_embedding))::FLOAT AS similarity
FROM code_chunks
WHERE project_id = p_project_id AND embedding_status = 'ready'
ORDER BY embedding <=> p_embedding
LIMIT p_limit;
$$ LANGUAGE SQL STABLE;
```

---

## Phase 5: Integration with Orchestrator (Days 10-11)

### 5.1 Embedding Task Pipeline

**File**: `memory/embed_task.py`

```python
"""Queue and execute embedding tasks for code repositories."""

import asyncio
import logging
from typing import Optional, List
from datetime import datetime
import asyncpg

from code_chunker import ASTCodeChunker, CodeChunk
from code_embedder import CodeEmbedder
from dependency_graph import DependencyGraphBuilder

logger = logging.getLogger(__name__)


class EmbeddingPipeline:
    """Orchestrate code chunking, embedding, and storage."""
    
    def __init__(self, db_pool: asyncpg.Pool):
        self.pool = db_pool
        self.chunker = ASTCodeChunker()
        self.embedder = CodeEmbedder(device='cuda')
        self.dep_graph = DependencyGraphBuilder()
    
    async def embed_project(
        self,
        project_id: str,
        repo_path: str,
        force_reindex: bool = False
    ) -> dict:
        """
        Complete embedding pipeline for a project.
        
        Returns:
            {
                'project_id': str,
                'chunks_indexed': int,
                'embeddings_created': int,
                'duration_seconds': float,
                'status': 'success' | 'error'
            }
        """
        start_time = datetime.now()
        
        try:
            # Step 1: Parse repository into chunks
            logger.info(f"[{project_id}] Chunking repository: {repo_path}")
            chunks = list(self.chunker.chunk_repository(repo_path))
            flat_chunks = [c for batch in chunks for c in batch]
            logger.info(f"[{project_id}] Created {len(flat_chunks)} chunks")
            
            # Step 2: Build dependency graph
            logger.info(f"[{project_id}] Building dependency graph")
            self.dep_graph.add_repository(repo_path)
            pagerank_scores = self.dep_graph.compute_pagerank()
            logger.info(f"[{project_id}] Graph has {len(pagerank_scores)} nodes")
            
            # Step 3: Embed chunks
            logger.info(f"[{project_id}] Embedding chunks with CodeBERT")
            chunk_dicts = [
                {
                    'content': c.content,
                    'file_path': c.file_path,
                    'symbol_name': c.symbol_name,
                    'chunk_type': c.chunk_type,
                    'start_line': c.start_line,
                    'end_line': c.end_line,
                    'language': c.language,
                    'content_hash': c.content_hash,
                    'metadata': c.metadata
                }
                for c in flat_chunks
            ]
            
            embedded_chunks = self.embedder.embed_chunks(chunk_dicts)
            logger.info(f"[{project_id}] Embedded {len(embedded_chunks)} chunks")
            
            # Step 4: Store in database
            async with self.pool.acquire() as conn:
                async with conn.transaction():
                    # Update project status
                    await conn.execute("""
                        UPDATE project_tracking
                        SET code_embedding_status = 'indexing',
                            embedding_completion_percent = 0
                        WHERE project_id = $1
                    """, project_id)
                    
                    # Store chunks
                    for i, chunk in enumerate(embedded_chunks):
                        # Look up PageRank
                        symbol_key = f"{chunk['file_path']}:func:{chunk['symbol_name']}"
                        pagerank = pagerank_scores.get(symbol_key, 0.0)
                        
                        await conn.execute("""
                            INSERT INTO code_chunks (
                                project_id, file_path, symbol_name, chunk_type,
                                start_line, end_line, content, content_hash,
                                embedding, embedding_model, pagerank_score,
                                language, embedding_status
                            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'ready')
                            ON CONFLICT (project_id, file_path, symbol_name) DO UPDATE SET
                                content = $7,
                                content_hash = $8,
                                embedding = $9,
                                pagerank_score = $11,
                                embedding_status = 'ready',
                                updated_at = NOW()
                        """,
                            project_id,
                            chunk['file_path'],
                            chunk['symbol_name'],
                            chunk['chunk_type'],
                            chunk['start_line'],
                            chunk['end_line'],
                            chunk['content'],
                            chunk['content_hash'],
                            chunk['embedding'].tolist(),  # Convert to list for pgvector
                            'microsoft/codebert-base',
                            pagerank
                        )
                        
                        # Progress update
                        if (i + 1) % 100 == 0:
                            percent = (i + 1) / len(embedded_chunks) * 100
                            await conn.execute("""
                                UPDATE project_tracking
                                SET embedding_completion_percent = $1
                                WHERE project_id = $2
                            """, percent, project_id)
                    
                    # Mark project as ready
                    await conn.execute("""
                        UPDATE project_tracking
                        SET code_embedding_status = 'ready',
                            code_chunks_count = $1,
                            embedding_completion_percent = 100.0
                        WHERE project_id = $2
                    """, len(embedded_chunks), project_id)
            
            duration = (datetime.now() - start_time).total_seconds()
            return {
                'project_id': project_id,
                'chunks_indexed': len(embedded_chunks),
                'duration_seconds': duration,
                'status': 'success'
            }
        
        except Exception as e:
            logger.error(f"[{project_id}] Embedding failed: {e}", exc_info=True)
            
            # Mark as error
            async with self.pool.acquire() as conn:
                await conn.execute("""
                    UPDATE project_tracking
                    SET code_embedding_status = 'error'
                    WHERE project_id = $1
                """, project_id)
            
            return {
                'project_id': project_id,
                'status': 'error',
                'error': str(e)
            }


# Integration with task queue
async def embedding_worker_task(
    task_id: str,
    project_id: str,
    repo_path: str,
    db_pool: asyncpg.Pool
):
    """Execute as a task in orchestrator."""
    pipeline = EmbeddingPipeline(db_pool)
    result = await pipeline.embed_project(project_id, repo_path)
    
    # Update task in queue
    return result
```

### 5.2 Query Interface

**File**: `memory/code_search.py`

```python
"""Query code embeddings using hybrid search."""

import logging
from typing import List, Optional, Dict
import numpy as np
import asyncpg

from code_embedder import CodeEmbedder

logger = logging.getLogger(__name__)


class CodeSearcher:
    """Query code embeddings with hybrid retrieval."""
    
    def __init__(self, db_pool: asyncpg.Pool):
        self.pool = db_pool
        self.embedder = CodeEmbedder(device='cuda')
    
    async def search(
        self,
        project_id: str,
        query: str,
        top_k: int = 20,
        use_hybrid: bool = True
    ) -> List[Dict]:
        """
        Search code by semantic meaning.
        
        Args:
            project_id: Project to search within
            query: Natural language or code query
            top_k: Number of results
            use_hybrid: Use hybrid (vector + BM25 + PageRank) or vector-only
        
        Returns:
            [{chunk_id, symbol_name, file_path, similarity, code_snippet}, ...]
        """
        # Embed query
        query_embedding = self.embedder.embed_single(query)
        
        async with self.pool.acquire() as conn:
            if use_hybrid:
                # Hybrid search
                results = await conn.fetch("""
                    SELECT * FROM hybrid_code_search(
                        $1, $2, $3,
                        p_semantic_weight := 1.0,
                        p_lexical_weight := 1.0,
                        p_structural_weight := 0.2,
                        p_limit := $4
                    )
                """, project_id, query_embedding.tolist(), query, top_k)
            else:
                # Vector-only search
                results = await conn.fetch("""
                    SELECT * FROM vector_code_search($1, $2, $3)
                """, project_id, query_embedding.tolist(), top_k)
            
            # Enrich results with content snippets
            enriched = []
            for row in results:
                chunk = await conn.fetchrow("""
                    SELECT content, start_line, end_line FROM code_chunks
                    WHERE id = $1
                """, row['chunk_id'])
                
                enriched.append({
                    'chunk_id': row['chunk_id'],
                    'symbol_name': row['symbol_name'],
                    'file_path': row['file_path'],
                    'similarity': float(row.get('similarity_score', 0)),
                    'relevance': float(row.get('relevance_score', 0)),
                    'start_line': chunk['start_line'],
                    'end_line': chunk['end_line'],
                    'code_snippet': chunk['content'][:200] + '...',  # Preview
                })
            
            return enriched
    
    async def search_by_type(
        self,
        project_id: str,
        query: str,
        chunk_type: str,  # 'function', 'class', 'module'
        top_k: int = 20
    ) -> List[Dict]:
        """Filter search results by chunk type."""
        results = await self.search(project_id, query, top_k * 2)
        
        # Filter
        filtered = [r for r in results if r.get('chunk_type') == chunk_type]
        
        return filtered[:top_k]


# Usage example
async def example():
    pool = await asyncpg.create_pool(
        'postgresql://user:password@localhost/knowledge_manager'
    )
    
    searcher = CodeSearcher(pool)
    
    # Search for authentication-related code
    results = await searcher.search(
        project_id='my-project-uuid',
        query='how do I verify user credentials?',
        top_k=10,
        use_hybrid=True
    )
    
    for result in results:
        print(f"[{result['similarity']:.3f}] {result['symbol_name']} ({result['file_path']})")
        print(f"  → {result['code_snippet']}\n")
    
    await pool.close()
```

---

## Phase 6: Orchestrator Integration (Days 12-13)

### 6.1 Add Embedding Endpoints

**File**: `docker/orchestrator/memory_routes.py`

```python
"""REST API endpoints for code memory and search."""

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import List, Optional
import asyncpg
from memory.code_search import CodeSearcher
from memory.embed_task import EmbeddingPipeline

router = APIRouter(prefix="/memory", tags=["memory"])


class SearchRequest(BaseModel):
    query: str
    top_k: int = 20
    use_hybrid: bool = True


class SearchResult(BaseModel):
    chunk_id: int
    symbol_name: Optional[str]
    file_path: str
    similarity: float
    code_snippet: str
    start_line: int
    end_line: int


@router.post("/code-search/{project_id}", response_model=List[SearchResult])
async def code_search(
    project_id: str,
    request: SearchRequest,
    pool: asyncpg.Pool
):
    """Search code embeddings."""
    searcher = CodeSearcher(pool)
    
    try:
        results = await searcher.search(
            project_id=project_id,
            query=request.query,
            top_k=request.top_k,
            use_hybrid=request.use_hybrid
        )
        return results
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/embed-project/{project_id}")
async def trigger_embedding(
    project_id: str,
    repo_path: str,
    force_reindex: bool = False,
    pool: asyncpg.Pool = None
):
    """Queue embedding job for project."""
    pipeline = EmbeddingPipeline(pool)
    
    result = await pipeline.embed_project(
        project_id=project_id,
        repo_path=repo_path,
        force_reindex=force_reindex
    )
    
    return result


@router.get("/embedding-status/{project_id}")
async def get_embedding_status(project_id: str, pool: asyncpg.Pool):
    """Get embedding progress for project."""
    async with pool.acquire() as conn:
        status = await conn.fetchrow("""
            SELECT
                code_embedding_status,
                code_chunks_count,
                embedding_completion_percent
            FROM project_tracking
            WHERE project_id = $1
        """, project_id)
    
    if not status:
        raise HTTPException(status_code=404, detail="Project not found")
    
    return status
```

### 6.2 Update Web UI

Add code search widget to your orchestrator viewer dashboard.

---

## Phase 7: Testing & Optimization (Days 14-15)

### 7.1 Performance Benchmarks

**File**: `memory/benchmark.py`

```python
"""Benchmark embedding performance."""

import time
import asyncpg
from code_embedder import CodeEmbedder
from code_chunker import ASTCodeChunker


async def benchmark_embedding():
    """Measure embedding speed."""
    embedder = CodeEmbedder(device='cuda')
    
    test_codes = [
        "def hello(): return 'world'",
        "class MyClass:\n    def method(self): pass",
        "import os\nimport sys\nprint('hi')",
    ] * 100  # 300 samples
    
    start = time.time()
    embeddings = embedder.embed_batch(test_codes)
    duration = time.time() - start
    
    throughput = len(test_codes) / duration
    print(f"Embedding: {throughput:.1f} chunks/sec ({duration:.2f}s for {len(test_codes)})")
    
    # Memory usage
    print(f"Embedding shape: {embeddings.shape}")


async def benchmark_search(pool: asyncpg.Pool, project_id: str):
    """Measure search latency."""
    embedder = CodeEmbedder(device='cuda')
    
    # Sample query
    query = "How do I authenticate users?"
    query_embedding = embedder.embed_single(query)
    
    times = []
    for _ in range(10):
        start = time.time()
        
        async with pool.acquire() as conn:
            await conn.fetch("""
                SELECT * FROM vector_code_search($1, $2, $3)
            """, project_id, query_embedding.tolist(), 20)
        
        times.append(time.time() - start)
    
    avg_time = sum(times) / len(times)
    print(f"Search latency: {avg_time*1000:.1f}ms (avg of {len(times)} queries)")
```

---

## Quick Start Checklist

```bash
# 1. Install dependencies
pip install -r memory/requirements-advanced.txt

# 2. Run schema migrations
docker exec km-postgres psql -U km_user -d knowledge_manager \
  -f /docker-entrypoint-initdb.d/03_code_embeddings.sql

# 3. Download models (first run only)
python -m sentence_transformers download microsoft/codebert-base

# 4. Test chunking
python memory/test_chunker.py

# 5. Index a project
python -c "
import asyncio
from memory.embed_task import EmbeddingPipeline
import asyncpg

async def main():
    pool = await asyncpg.create_pool('postgresql://km_user:password@localhost/knowledge_manager')
    pipeline = EmbeddingPipeline(pool)
    result = await pipeline.embed_project(
        'your-project-id',
        '/path/to/repo'
    )
    print(result)
    await pool.close()

asyncio.run(main())
"

# 6. Test search
curl -X POST http://localhost:8000/memory/code-search/your-project-id \
  -H "Content-Type: application/json" \
  -d '{"query": "user authentication", "top_k": 5}'
```

---

## Expected Results

After full implementation:

✅ **Semantic code search**: Find functions by meaning, not just keywords  
✅ **PageRank ranking**: Surface important code first  
✅ **Incremental updates**: Re-embed only changed code (90% faster)  
✅ **Hybrid retrieval**: Combine vectors + keywords + structure  
✅ **IDE integration**: Search from CLI or Web UI  
✅ **LLM context**: Automatically inject relevant code into task prompts  

**Performance targets**:
- Embedding: 50+ chunks/second on RTX 5090
- Search latency: <100ms for 50K-chunk codebase
- Memory per million chunks: <4GB

---

## Troubleshooting

### Out of Memory During Embedding
- Reduce `batch_size` in `CodeEmbedder.__init__()` (default: 32 → try 16)
- Process files in smaller batches
- Enable GPU memory growth: `torch.cuda.empty_cache()`

### ParadeDB Not Found
- Ensure PostgreSQL version is 14+ (ParadeDB requirement)
- Install ParadeDB extension: `CREATE EXTENSION pg_search`

### Query Returns No Results
- Verify `embedding_status = 'ready'` for chunks
- Check that `project_id` matches in table
- Ensure embeddings are properly normalized (pgvector should handle)

---

## Next Steps (After Core Implementation)

1. **MCP Integration**: Connect to Claude via Model Context Protocol
2. **Watch Mode**: Auto-index on file changes (using watchdog)
3. **Caching**: LRU cache for frequent queries
4. **Fine-tuning**: Train CodeBERT on your codebase for better domain fit
5. **Multi-language**: Add support for Go, Rust, C++ via tree-sitter

