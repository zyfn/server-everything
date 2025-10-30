import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { InMemoryEventStore } from '@modelcontextprotocol/sdk/examples/shared/inMemoryEventStore.js';
import express from "express";
import { createServer } from "./everything.js";
import { randomUUID } from 'node:crypto';
console.error('Starting Streamable HTTP server...');
const app = express();
const { server, cleanup } = createServer();
const transports = {};
app.post('/mcp', async (req, res) => {
    console.log('Received MCP POST request');
    try {
        // Check for existing session ID
        const sessionId = req.headers['mcp-session-id'];
        let transport;
        if (sessionId && transports[sessionId]) {
            // Reuse existing transport
            transport = transports[sessionId];
        }
        else if (!sessionId) {
            // New initialization request
            const eventStore = new InMemoryEventStore();
            transport = new StreamableHTTPServerTransport({
                sessionIdGenerator: () => randomUUID(),
                eventStore, // Enable resumability
                onsessioninitialized: (sessionId) => {
                    // Store the transport by session ID when session is initialized
                    // This avoids race conditions where requests might come in before the session is stored
                    console.log(`Session initialized with ID: ${sessionId}`);
                    transports[sessionId] = transport;
                }
            });
            // Set up onclose handler to clean up transport when closed
            transport.onclose = () => {
                const sid = transport.sessionId;
                if (sid && transports[sid]) {
                    console.log(`Transport closed for session ${sid}, removing from transports map`);
                    delete transports[sid];
                }
            };
            // Connect the transport to the MCP server BEFORE handling the request
            // so responses can flow back through the same transport
            await server.connect(transport);
            await transport.handleRequest(req, res);
            return; // Already handled
        }
        else {
            // Invalid request - no session ID or not initialization request
            res.status(400).json({
                jsonrpc: '2.0',
                error: {
                    code: -32000,
                    message: 'Bad Request: No valid session ID provided',
                },
                id: req?.body?.id,
            });
            return;
        }
        // Handle the request with existing transport - no need to reconnect
        // The existing transport is already connected to the server
        await transport.handleRequest(req, res);
    }
    catch (error) {
        console.error('Error handling MCP request:', error);
        if (!res.headersSent) {
            res.status(500).json({
                jsonrpc: '2.0',
                error: {
                    code: -32603,
                    message: 'Internal server error',
                },
                id: req?.body?.id,
            });
            return;
        }
    }
});
// Handle GET requests for SSE streams (using built-in support from StreamableHTTP)
app.get('/mcp', async (req, res) => {
    console.log('Received MCP GET request');
    const sessionId = req.headers['mcp-session-id'];
    if (!sessionId || !transports[sessionId]) {
        res.status(400).json({
            jsonrpc: '2.0',
            error: {
                code: -32000,
                message: 'Bad Request: No valid session ID provided',
            },
            id: req?.body?.id,
        });
        return;
    }
    // Check for Last-Event-ID header for resumability
    const lastEventId = req.headers['last-event-id'];
    if (lastEventId) {
        console.log(`Client reconnecting with Last-Event-ID: ${lastEventId}`);
    }
    else {
        console.log(`Establishing new SSE stream for session ${sessionId}`);
    }
    const transport = transports[sessionId];
    await transport.handleRequest(req, res);
});
// Handle DELETE requests for session termination (according to MCP spec)
app.delete('/mcp', async (req, res) => {
    const sessionId = req.headers['mcp-session-id'];
    if (!sessionId || !transports[sessionId]) {
        res.status(400).json({
            jsonrpc: '2.0',
            error: {
                code: -32000,
                message: 'Bad Request: No valid session ID provided',
            },
            id: req?.body?.id,
        });
        return;
    }
    console.log(`Received session termination request for session ${sessionId}`);
    try {
        const transport = transports[sessionId];
        await transport.handleRequest(req, res);
    }
    catch (error) {
        console.error('Error handling session termination:', error);
        if (!res.headersSent) {
            res.status(500).json({
                jsonrpc: '2.0',
                error: {
                    code: -32603,
                    message: 'Error handling session termination',
                },
                id: req?.body?.id,
            });
            return;
        }
    }
});
// Start the server
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
    console.log(`MCP Streamable HTTP Server listening on port ${PORT}`);
});
// Handle server shutdown
process.on('SIGINT', async () => {
    console.log('Shutting down server...');
    // Close all active transports to properly clean up resources
    for (const sessionId in transports) {
        try {
            console.log(`Closing transport for session ${sessionId}`);
            await transports[sessionId].close();
            delete transports[sessionId];
        }
        catch (error) {
            console.error(`Error closing transport for session ${sessionId}:`, error);
        }
    }
    await cleanup();
    await server.close();
    console.log('Server shutdown complete');
    process.exit(0);
});
