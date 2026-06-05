.PHONY: install lint build test clean \
        compose-up compose-down compose-logs \
        compose-test-up compose-test-down \
        e2e ci-local

install:
	npm install --no-audit --no-fund

lint:
	npm run lint

build:
	npm run build

test:
	npm test

clean:
	rm -rf lib coverage .build node_modules

compose-up:
	docker compose -f docker/docker-compose.dev.yml --env-file .env up -d

compose-down:
	docker compose -f docker/docker-compose.dev.yml down

compose-logs:
	docker compose -f docker/docker-compose.dev.yml logs -f pod-gitlab

compose-test-up:
	docker compose -f docker/docker-compose.test.yml up -d

compose-test-down:
	docker compose -f docker/docker-compose.test.yml down

e2e:
	E2E_REAL_STACK=1 npm run test:e2e

ci-local:
	npm run lint && npm run build && npm test
