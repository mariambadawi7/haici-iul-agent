# IUL Agent - Multimodal RAG Assistant

A fully local, multimodal Retrieval-Augmented Generation (RAG) assistant designed for the Islamic University of Lebanon (IUL). The system provides a cinematic and premium user interface with voice-to-text (Whisper), text-to-voice (Piper TTS), intelligent response generation (Ollama / Gemini), and semantic search (Qdrant), entirely orchestrated by n8n.

## Features
- **Cinematic UI**: Split-screen design with an interactive 3D avatar and dynamic typography.
- **Real-Time Voice Support**: Direct UI integration with local Whisper containers for sub-second Speech-to-Text transcription.
- **Workflow Automation**: Built on n8n for highly configurable inference chains.
- **Offline / Local First**: Fully containerized setup for Whisper, Piper TTS, Qdrant (Vector DB), and Ollama.

## Project Structure
- `web/`: The Vite + React + TypeScript frontend application.
- `docker-compose.yml`: Orchestrates all the microservices required to run the agent locally.
- `workflow.json`: The core n8n workflow blueprint that handles RAG, LLM inference, and text-to-speech.
- `shared_docs/`: Directory for files mapped to n8n for auto-ingestion into the Qdrant vector database.

---

## Getting Started

### 1. Prerequisites
Ensure you have the following installed on your machine:
- [Docker Desktop](https://www.docker.com/products/docker-desktop/) or Docker Engine
- Git

### 2. Installation
Clone this repository and navigate into it:
```bash
git clone <your-repo-url>
cd agent
```

### 3. Spin Up the Environment
Start all the required background services using Docker Compose:
```bash
docker compose up -d
```
This will download the required images and start:
- **web**: Frontend interface (`http://localhost:5173`)
- **n8n**: Workflow automation engine (`http://localhost:5678`)
- **ollama**: Local LLM server
- **qdrant**: Vector database for RAG
- **whisper**: Local Speech-to-Text inference
- **piper**: Local Text-to-Speech inference

### 4. Setting up the Workflow (n8n)
1. Navigate to the n8n dashboard at `http://localhost:5678`.
2. Skip the onboarding or set up an owner account.
3. Click on **Workflows** -> **Add Workflow** -> **Import from File**.
4. Select the `workflow.json` file included in this repository.
5. If using Gemini, add your Google API Key credentials inside the Gemini Chat Model node.
6. **Activate the workflow** by toggling the switch in the top right corner. *(Note: The Webhook will return 404s to the frontend until it is actively published!).*

### 5. Using the Application
Open your browser and navigate to:
**`http://localhost:5173`**

You can now interact with the assistant via text or voice!

---

## Managing Local Models with Ollama

Ollama allows you to download and run open-source Large Language Models completely locally on your hardware.

### Downloading New Models
To add a new model (for example, `llama3` or `mistral`) to your running Ollama container:

1. Open your terminal and execute into the Ollama container:
   ```bash
   docker exec -it ollama bash
   ```
2. Pull the model using the Ollama CLI:
   ```bash
   ollama pull llama3
   ```
   *(You can find a full list of supported models at [ollama.com/library](https://ollama.com/library))*

### Using the Model in n8n
1. Once the model is successfully downloaded, open your n8n workflow editor.
2. Locate the **Ollama Chat Model** node.
3. Update the **Model** field to match the exact name of the model you just downloaded (e.g., `llama3`).
4. Save and re-publish your workflow. The assistant will now use the new local model for inference!
