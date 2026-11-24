# Failures (after, 160 cases)

- `KE-ADR-005` (synthesis, assistant, holdout=False): facts missing from the grounded answer: ['Черновик (draft) никогда не авторитетен']
- `KE-INTA-012` (synthesis, assistant, holdout=False): not cited: ['DEMO-INT-002'] (cited ['DEMO-INT-001', 'DEMO-SRC-002', 'DEMO-INT-001', 'DEMO-SEM-002'], confidence partial)
- `KE-SEM-011` (synthesis, assistant, holdout=False): facts missing from the grounded answer: ['mapping_state = retired']
- `KE-SEM-012` (synthesis, assistant, holdout=True): facts missing from the grounded answer: ['ROLE-014', 'E-MAP-001']
- `KE-SRC-004` (synonym, search, holdout=True): expected ['DEMO-SRC-008'] within top 3, got ['DEMO-SEM-003', 'DEMO-PROC-008', 'DEMO-GUIDE-001']
- `KE-SRC-012` (synthesis, assistant, holdout=False): not cited: ['DEMO-SRC-004'] (cited ['DEMO-INT-006', 'DEMO-INT-006', 'DEMO-SRC-006'], confidence partial); facts missing from the grounded answer: ['mdm_golden_id', 'mdm_match_score']
- `KE-SRC-013` (synthesis, assistant, holdout=False): facts missing from the grounded answer: ['DQ-COMP-001', '95 %', '24 ч']
- `KE-ST-006` (status, assistant, holdout=False): not cited: ['DEMO-SEM-012'] (cited ['DEMO-SEM-003', 'DEMO-SEM-008', 'DEMO-SEM-008', 'DEMO-SEM-001'], confidence supported)
- `KX-RAG-04` (external_rag, assistant, holdout=True): not cited: ['200104'] (cited ['DEMO-SRC-007', 'DEMO-PROC-003', 'DEMO-INT-004', 'DEMO-INT-001'], confidence partial); facts missing from the grounded answer: ['internal']
