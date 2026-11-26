# Failures — probes_before

- `RQ-MS-01` (rq_multisection, assistant, fail): facts missing from the grounded answer: ['-r1']
- `RQ-MS-02` (rq_multisection, assistant, fail): facts missing from the grounded answer: ['15 мин 30 с']
- `RQ-MS-03` (rq_multisection, assistant, fail): facts missing from the grounded answer: ['отсутствует в следующем полном снимке']
- `RQ-MD-01` (rq_multidoc, assistant, fail): facts missing from the grounded answer: ['02:30']
- `RQ-MD-02` (rq_multidoc, assistant, fail): facts missing from the grounded answer: ['72 ч']
- `RQ-CAN-02` (rq_canonical, assistant, fail): facts missing from the grounded answer: ['30 с']
- `RQ-PAR-02` (rq_paraphrase, search, fail): expected ['DEMO-INT-011'] within top 3, got ['DEMO-PROC-008', 'DEMO-GUIDE-001', 'DEMO-PROC-003']
- `RQ-EXT-04` (rq_external, assistant, fail): not cited: ['200115'] (cited ['DEMO-SRC-003', 'DEMO-INT-004', 'DEMO-INT-004'], confidence supported); external called=False, expected True
- `RQ-EXT-N1` (rq_external_negative, assistant, fail): not cited: ['DEMO-INT-011'] (cited [], confidence insufficient_evidence); external called=True, expected False
