---
key: smoke-test-implementation-plan
tags:
  - smoke-test
  - docker
  - implementation
  - plan
created: 2026-06-25T01:27:12.872Z
updated: 2026-06-25T01:30:11.805Z
---

# Smoke Test Implementation Plan

## Goal
Get `docker:smoke-test` script to run successfully with beacon+agent smoke tests.

## Items (Sequential)

### 1. Fix echo-llm ✅ DONE
- [x] Add docker/echo-llm/src/logger.ts
- [x] Add docker/echo-llm/tsconfig.json
- [x] Update docker/echo-llm.Dockerfile to build

### 2. Fix smoke-test ✅ DONE
- [x] Verify docker/smoke-test/package.json has dependencies
- [x] Update docker/smoke-test.Dockerfile to build properly

### 3. Fix memory test route ✅ DONE
- [x] Change test to use GET /memory/key/:key?namespace=default

### 4. Add build scripts to root package.json ✅ DONE
- [x] Add docker:build, docker:up, docker:down

### 5. Make coordinator actually register beacons
- [ ] Beacon should auto-register on startup if coordinator configured

### 6. Add meaningful agent test
- [ ] Test that agent connects to beacon and can chat

### 7. Add docker:smoke-test script
- [ ] Add docker:smoke-test script that builds + runs + cleans

### 8. Add CI integration
- [ ] Add CI integration

---

*Created: 2026-06-25*
*Status: Item 4 complete*
*Commit: 640dc2c*