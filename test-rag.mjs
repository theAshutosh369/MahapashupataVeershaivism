await new Promise(r => setTimeout(r, 3000)); // Give it 3 seconds to warm up

try {
    const response = await fetch('http://localhost:3001/api/rag/status', { method: 'GET' });
    const data = await response.json();
    console.log('RAG Status:', JSON.stringify(data, null, 2));
} catch (error) {
    console.error('Error:', error.message);
}
