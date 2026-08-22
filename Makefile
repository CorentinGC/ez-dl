# Makefile ez-dl — raccourcis pour le développement local et l'exploitation Docker.
# `make` seul (ou `make help`) affiche la liste des cibles disponibles.

.DEFAULT_GOAL := help

.PHONY: help install dev-server dev-extension test lint build-extension zip-extension publish-extension up up-gpu down logs rebuild

help: ## Affiche cette aide
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2}'

install: ## Installe les dépendances serveur (uv) et extension (npm)
	cd server && uv sync
	cd extension && npm install

dev-server: ## Lance le serveur FastAPI en local avec rechargement à chaud
	cd server && uv run uvicorn app.main:app --reload --host 0.0.0.0 --port 8000

dev-extension: ## Lance l'extension en mode développement (WXT)
	cd extension && npm run dev

test: ## Lance les tests du serveur (pytest)
	cd server && uv run pytest -q

lint: ## Lint + vérifie le formatage du serveur (ruff)
	cd server && uv run ruff check .
	cd server && uv run ruff format --check .

build-extension: ## Build de production de l'extension Chrome
	cd extension && npm run build

zip-extension: ## Empaquette l'extension en zip (identique à celui publié par le serveur)
	cd extension && npm run zip

publish-extension: ## Republie l'extension sur le serveur (après un bump de version)
	docker compose build server
	docker compose up -d server

up: ## Démarre la stack Docker (serveur) en arrière-plan
	docker compose up -d

up-gpu: ## Démarre la stack Docker avec l'override GPU NVIDIA
	docker compose -f docker-compose.yml -f docker-compose.gpu.yml up -d

down: ## Arrête la stack Docker
	docker compose down

logs: ## Suit les logs du serveur en continu
	docker compose logs -f server

rebuild: ## Reconstruit l'image Docker sans cache et redémarre la stack
	docker compose build --no-cache
	docker compose up -d
