# Project Spec

## 1. Product Goal
Build a desktop app similar to LM Studio that manages local LLMs and supports OpenAI-compatible and Anthropic API servers.

## 2. Core Features

### Model Management
- List installed models
- Import model from local path
- Show model size, format, status

### Local API Server
- Start / stop server
- Support `/v1/models`
- Support `/v1/chat/completions`
- API key authentication
- Request logging
    - Storing in SQLite
    - Website for the dashboard with multiple roles
        - Roles
            - Admin
                - Viewing personal / overall information
                    - Token usage
                    - Input / Output prompt for each request
                - Manage all users data
                    - API Key 
                    - Password
                    - Name
                    - Roles
            - User
                - Viewing personal information
                    - Token usage
                    - Input / Output prompt for each request
                - Manage Personal data
                    - API Key 
                    - Password
                    - Name
        - Page: Each page show contain the search and number per page function.
            - Overview tab: An overview dashboard that shows the following information
                - Request number
                - Input / Output token number
                - Model request number
                - Chart for each model usage
            - Prompts tab: Show input / output prompts and token usage for each request and the API Key.
            - Admin tab (only for Admin role): Show all user account
                - Username
                - Role
                - Assigned API KEYS
                - Action (be able to disable / enable / delete the account)
            - Profile tab: Show personal account infomation
                - Username
                - role
                - API keys (user can also add / remove the given API KEY)
                - Change password
    - Input and output token usage
- Network function

### UI
- Sidebar navigation
- Model list page
- Server status page
- Logs page
- Settings page

## 3. Non-goals (v1)
- No model training
- No Hugging Face downloading
- No GPU optimization

## 4. Tech Stack
- Tauri + React + TypeScript
- Backend: Rust or Node sidecar
- UI library must be commercially usable

## 5. Acceptance Tests
- App launches successfully
- Models are listed
- Server starts correctly
- `curl http://localhost:1234/v1/models` works
- Logs are visible in UI