import React, { useState, useRef, useEffect, useCallback } from 'react';
import { createRoot } from 'react-dom/client';
import { GoogleGenAI, Type, Modality, LiveServerMessage, Blob, FunctionDeclaration, Chat } from '@google/genai';
import { jsPDF } from 'jspdf';
import 'bootstrap/dist/css/bootstrap.min.css';
import LandingPage from './src/assets/landingPage.tsx';
import { createBrowserRouter, RouterProvider } from 'react-router-dom';

// --- Helper Functions ---
function encode(bytes) {
  let binary = '';
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function decode(base64) {
    const binaryString = atob(base64);
    const len = binaryString.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
        bytes[i] = binaryString.charCodeAt(i);
    }
    return bytes;
}

async function decodeAudioData(data, ctx, sampleRate, numChannels) {
    const dataInt16 = new Int16Array(data.buffer);
    const frameCount = dataInt16.length / numChannels;
    const buffer = ctx.createBuffer(numChannels, frameCount, sampleRate);

    for (let channel = 0; channel < numChannels; channel++) {
        const channelData = buffer.getChannelData(channel);
        for (let i = 0; i < frameCount; i++) {
            channelData[i] = dataInt16[i * numChannels + channel] / 32768.0;
        }
    }
    return buffer;
}

const fileToDataUrl = (file: File): Promise<string> => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.readAsDataURL(file);
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = error => reject(error);
});

const dataUrlToBase64 = (dataUrl: string) => dataUrl.split(',')[1];

// --- Static Constants ---
// Moved outside component to prevent recreation on every render
const triageSchema = {
    type: Type.OBJECT,
    properties: {
        Triage_ID: { type: Type.STRING },
        Patient_Language_Used: { type: Type.STRING },
        Chief_Complaint_EN: { type: Type.STRING },
        Triage_Priority_Score: { type: Type.STRING, enum: ['HIGH', 'MEDIUM', 'LOW'] },
        Structured_Symptom_List: { type: Type.ARRAY, items: { type: Type.STRING } },
        AI_Rationale: { type: Type.STRING },
    },
    required: ['Triage_ID', 'Patient_Language_Used', 'Chief_Complaint_EN', 'Triage_Priority_Score', 'Structured_Symptom_List', 'AI_Rationale']
};

const submitTriageReportFunctionDeclaration: FunctionDeclaration = {
    name: 'submitTriageReport',
    description: 'Submits the final triage report once all necessary information has been gathered from the patient.',
    parameters: triageSchema
};

// --- Components ---

const LoginScreen = ({ onLogin }) => (
    <div className="card shadow-sm h-100">
        <div className="card-header bg-primary text-white">
            <h1 className="h4 m-0">Doc Rush</h1>
        </div>
        <main className="card-body d-flex flex-column justify-content-center align-items-center text-center">
            <h2 className="display-5">Welcome to Doc Rush</h2>
            <p className="lead">Your AI-powered medical triage assistant.</p>
            <div className="mt-3 d-flex flex-wrap justify-content-center gap-2">
                <button className="btn btn-primary btn-lg px-4 py-2" onClick={() => onLogin('patient')}>I'm a Patient</button>
                <button className="btn btn-secondary btn-lg px-4 py-2" onClick={() => onLogin('doctor')}>I'm a Doctor</button>
                <button className="btn btn-info btn-lg px-4 py-2" onClick={() => onLogin('clinic')}>I'm Clinic Staff</button>
            </div>
        </main>
    </div>
);

const PatientView = ({ onTriageComplete, onLogout }) => {
    // Shared state
    const [triageMode, setTriageMode] = useState('start'); // 'start', 'audio', 'chat'
    const [transcript, setTranscript] = useState([]);
    const [isLoading, setIsLoading] = useState(false); // For final report generation
    const [userLocation, setUserLocation] = useState(null);
    const [locationError, setLocationError] = useState('');

    // Audio state and refs
    const [isSessionActive, setIsSessionActive] = useState(false);
    const [statusText, setStatusText] = useState('Click below to start your triage conversation.');
    const [micVolume, setMicVolume] = useState(0);
    const [micPermission, setMicPermission] = useState('idle'); // 'idle', 'prompting', 'granted', 'denied'
    const sessionPromiseRef = useRef<Promise<any> | null>(null);
    const outputAudioContextRef = useRef<AudioContext | null>(null);
    const nextStartTimeRef = useRef(0);
    const inputAudioContextRef = useRef<AudioContext | null>(null);
    const scriptProcessorRef = useRef<ScriptProcessorNode | null>(null);
    const mediaStreamSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
    const streamRef = useRef<MediaStream | null>(null);
    const analyserRef = useRef<AnalyserNode | null>(null);
    const animationFrameIdRef = useRef<number | null>(null);


    // Chat state and refs
    const chatSessionRef = useRef<Chat | null>(null);
    const [isChatLoading, setIsChatLoading] = useState(false);
    const [chatInputText, setChatInputText] = useState('');
    const [chatInputImage, setChatInputImage] = useState<File | null>(null);
    const transcriptEndRef = useRef<HTMLDivElement>(null);


    const scrollToBottom = () => {
        // Use rAF to avoid layout thrashing and potential freezes during rapid updates
        requestAnimationFrame(() => {
             transcriptEndRef.current?.scrollIntoView({ behavior: "smooth" });
        });
    };

    useEffect(() => {
        scrollToBottom();
    }, [transcript]);
    
    useEffect(() => {
        if (navigator.geolocation) {
            navigator.geolocation.getCurrentPosition(
                (position) => {
                    setUserLocation({
                        latitude: position.coords.latitude,
                        longitude: position.coords.longitude,
                    });
                    setLocationError('');
                },
                (error) => {
                    console.error("Geolocation error:", error);
                    setLocationError('Could not get your location. Nearby search will be less accurate.');
                }
            );
        } else {
             setLocationError('Geolocation is not supported by this browser.');
        }
    }, []);

    const handleTriageSubmit = useCallback((args: any) => {
        setIsLoading(true);
        setStatusText('Triage complete. Generating report...');
        // If in audio mode, cleanup will be handled by effect when unmounting or changing state,
        // but we can trigger local cleanup here if needed.
        onTriageComplete(args);
    }, [onTriageComplete]);

    // --- Audio Triage Logic ---
    const audioCleanup = useCallback(() => {
        if (animationFrameIdRef.current) {
            cancelAnimationFrame(animationFrameIdRef.current);
            animationFrameIdRef.current = null;
        }
        if (sessionPromiseRef.current) {
            sessionPromiseRef.current.then(session => session.close());
            sessionPromiseRef.current = null;
        }
        if (scriptProcessorRef.current) {
            scriptProcessorRef.current.disconnect();
            scriptProcessorRef.current = null;
        }
        if (analyserRef.current) {
            analyserRef.current.disconnect();
            analyserRef.current = null;
        }
        if (mediaStreamSourceRef.current) {
            mediaStreamSourceRef.current.disconnect();
            mediaStreamSourceRef.current = null;
        }
        if (inputAudioContextRef.current && inputAudioContextRef.current.state !== 'closed') {
            inputAudioContextRef.current.close();
            inputAudioContextRef.current = null;
        }
        if (outputAudioContextRef.current && outputAudioContextRef.current.state !== 'closed') {
            outputAudioContextRef.current.close();
            outputAudioContextRef.current = null;
        }
        if (streamRef.current) {
            streamRef.current.getTracks().forEach(track => track.stop());
            streamRef.current = null;
        }
        setIsSessionActive(false);
        setMicPermission('idle');
        setStatusText('Session ended. Click below to start a new triage conversation.');
    }, []);

    useEffect(() => {
        return () => { if (isSessionActive) audioCleanup() };
    }, [isSessionActive, audioCleanup]);

    const handleStartAudioTriage = async () => {
        // 0. Check for browser support
        if (!navigator.mediaDevices?.getUserMedia) {
            console.error('`navigator.mediaDevices.getUserMedia` is not available.');
            setMicPermission('denied');
            // The render logic will show a generic "access required" message which is sufficient.
            return;
        }

        // 1. Request microphone permission BEFORE connecting to the service
        setMicPermission('prompting');
        try {
            const mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
            streamRef.current = mediaStream;
            setMicPermission('granted');
        } catch (err) {
            console.error("Microphone access denied:", err);
            setMicPermission('denied');
            return; // Stop execution if permission is denied
        }

        // 2. If permission is granted, proceed to connect
        setTranscript([]);
        setStatusText('Connecting...');
        setIsSessionActive(true);

        try {
            const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
            let currentInputTranscription = '';
            let currentOutputTranscription = '';
            const sources = new Set<AudioBufferSourceNode>();
            outputAudioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
            nextStartTimeRef.current = 0;
            
            const config: any = {
                responseModalities: [Modality.AUDIO],
                speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Zephyr' } } },
                systemInstruction: `You are Doc Rush, an AI medical triage agent. Your goal is to conduct a friendly, conversational interview with the patient to gather information about their symptoms.
                1. Start by warmly greeting the patient and asking them to describe what's troubling them.
                2. Listen carefully and ask relevant follow-up questions to understand the situation fully (e.g., "How long has this been happening?", "Can you describe the pain?").
                3. Be empathetic and reassuring throughout the conversation.
                4. You can also help users find nearby clinics or pharmacies using your mapping tools.
                5. Once you have gathered sufficient information (chief complaint, symptoms, duration, severity), inform the patient you have everything you need.
                6. Then, call the 'submitTriageReport' function with all the collected information, formatted according to the schema. Do not ask the user for a Triage ID, generate it yourself.`,
                inputAudioTranscription: {},
                outputAudioTranscription: {},
                tools: [{ functionDeclarations: [submitTriageReportFunctionDeclaration] }, { googleMaps: {} }],
            };
    
            if (userLocation) {
                config.toolConfig = {
                  retrievalConfig: {
                    latLng: userLocation,
                  },
                };
            }

            sessionPromiseRef.current = ai.live.connect({
                model: 'gemini-2.5-flash-native-audio-preview-09-2025',
                callbacks: {
                    onopen: () => {
                        setStatusText('Microphone active. Please start speaking.');
                        // Create context with target sample rate of 16000, the browser will handle resampling.
                        inputAudioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
                        mediaStreamSourceRef.current = inputAudioContextRef.current.createMediaStreamSource(streamRef.current!);
                        scriptProcessorRef.current = inputAudioContextRef.current.createScriptProcessor(4096, 1, 1);
                        
                        scriptProcessorRef.current.onaudioprocess = (audioProcessingEvent) => {
                            // The input buffer is now already at 16000Hz.
                            const inputData = audioProcessingEvent.inputBuffer.getChannelData(0);
                            const pcmBlob: Blob = {
                                data: encode(new Uint8Array(new Int16Array(inputData.map(x => x * 32768)).buffer)),
                                mimeType: 'audio/pcm;rate=16000',
                            };
                            sessionPromiseRef.current?.then((session) => {
                                session.sendRealtimeInput({ media: pcmBlob });
                            });
                        };
                        mediaStreamSourceRef.current.connect(scriptProcessorRef.current);
                        scriptProcessorRef.current.connect(inputAudioContextRef.current.destination);

                        analyserRef.current = inputAudioContextRef.current.createAnalyser();
                        analyserRef.current.fftSize = 512;
                        mediaStreamSourceRef.current.connect(analyserRef.current);

                        const visualize = () => {
                            if (!analyserRef.current) {
                                return;
                            }
                            const bufferLength = analyserRef.current.frequencyBinCount;
                            const dataArray = new Uint8Array(bufferLength);
                            analyserRef.current.getByteTimeDomainData(dataArray);

                            let sumSquares = 0.0;
                            for (let i = 0; i < bufferLength; i++) {
                                const normSample = (dataArray[i] / 128.0) - 1.0;
                                sumSquares += normSample * normSample;
                            }
                            const rms = Math.sqrt(sumSquares / bufferLength);
                            setMicVolume(rms);

                            animationFrameIdRef.current = requestAnimationFrame(visualize);
                        };
                        visualize();

                    },
                    onmessage: async (message: LiveServerMessage) => {
                        if (message.serverContent?.inputTranscription) {
                            currentInputTranscription += message.serverContent.inputTranscription.text;
                            setStatusText('Listening...');
                        }
                        if (message.serverContent?.outputTranscription) {
                            currentOutputTranscription += message.serverContent.outputTranscription.text;
                             setStatusText('AI is speaking...');
                        }
                        if (message.serverContent?.turnComplete) {
                            if (currentInputTranscription) setTranscript(prev => [...prev, { speaker: 'user', text: currentInputTranscription }]);
                            if (currentOutputTranscription) setTranscript(prev => [...prev, { speaker: 'ai', text: currentOutputTranscription }]);
                            currentInputTranscription = '';
                            currentOutputTranscription = '';
                        }
                        const base64Audio = message.serverContent?.modelTurn?.parts[0]?.inlineData?.data;
                        if (base64Audio && outputAudioContextRef.current) {
                            nextStartTimeRef.current = Math.max(nextStartTimeRef.current, outputAudioContextRef.current.currentTime);
                            const audioBuffer = await decodeAudioData(decode(base64Audio), outputAudioContextRef.current, 24000, 1);
                            const source = outputAudioContextRef.current.createBufferSource();
                            source.buffer = audioBuffer;
                            source.connect(outputAudioContextRef.current.destination);
                            source.addEventListener('ended', () => sources.delete(source));
                            source.start(nextStartTimeRef.current);
                            nextStartTimeRef.current += audioBuffer.duration;
                            sources.add(source);
                        }
                        if (message.serverContent?.interrupted) {
                            sources.forEach(source => { source.stop(); sources.delete(source); });
                            nextStartTimeRef.current = 0;
                        }
                        if (message.toolCall?.functionCalls) {
                            for(const fc of message.toolCall.functionCalls) {
                                if (fc.name === 'submitTriageReport') handleTriageSubmit(fc.args);
                            }
                        }
                    },
                    onerror: (e) => {
                        console.error('Session error:', e);
                        setStatusText('An error occurred. Please try again.');
                        audioCleanup();
                    },
                    onclose: () => {
                        if(!isLoading) audioCleanup();
                    },
                },
                config: config,
            });

        } catch (err) {
            console.error("Error starting triage:", err);
            setStatusText('Could not connect to the triage service. Please try again.');
            audioCleanup();
        }
    };
    
    // --- Chat Triage Logic ---
    const initializeChat = useCallback(async () => {
        setIsChatLoading(true);
        setTranscript([]);
        try {
            const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
            
            const config: any = {
                systemInstruction: `You are Doc Rush, an AI medical triage agent. Your goal is to conduct a friendly, text-based chat interview with the patient to gather information about their symptoms. The patient may also upload images of their condition.
                1. Start by warmly greeting the patient and asking them to describe what's troubling them.
                2. Listen carefully (read their text) and ask relevant follow-up questions to understand the situation fully (e.g., "How long has this been happening?", "Can you describe the pain?"). If they upload an image, analyze it and ask clarifying questions.
                3. Be empathetic and reassuring throughout the conversation.
                4. You can also help users find nearby clinics or pharmacies using your mapping tools. When you do, the system will display links for the user.
                5. Once you have gathered sufficient information (chief complaint, symptoms, duration, severity), inform the patient you have everything you need.
                6. Then, call the 'submitTriageReport' function with all the collected information, formatted according to the schema. Do not ask the user for a Triage ID, generate it yourself.`,
                tools: [{ functionDeclarations: [submitTriageReportFunctionDeclaration] }, { googleMaps: {} }],
            };

            if (userLocation) {
                config.toolConfig = {
                    retrievalConfig: {
                        latLng: userLocation,
                    },
                };
            }
            
            chatSessionRef.current = ai.chats.create({
                model: 'gemini-2.5-flash',
                config: config,
            });

            // Start the conversation with a greeting
            const response = await chatSessionRef.current.sendMessage({ message: 'Hello' });
            setTranscript([{ speaker: 'ai', text: response.text }]);
        } catch (error) {
            console.error("Error initializing chat:", error);
            setTranscript([{ speaker: 'ai', text: "Sorry, I'm having trouble connecting. Please try again later." }]);
        } finally {
            setIsChatLoading(false);
        }
    }, [userLocation]); // Dependencies are now stable

    useEffect(() => {
        if (triageMode === 'chat' && !chatSessionRef.current) {
            initializeChat();
        }
        // Reset chat session if leaving chat mode to ensure fresh start on return
        if (triageMode !== 'chat') {
            chatSessionRef.current = null;
        }
    }, [triageMode, initializeChat]);

    const handleSendMessage = async () => {
        const text = chatInputText.trim();
        const imageFile = chatInputImage;

        if ((!text && !imageFile) || isChatLoading) return;

        setIsChatLoading(true);
        setChatInputText('');
        setChatInputImage(null);

        try {
            const userMessage: any = { speaker: 'user', text };
            const parts: any[] = [];

            if (imageFile) {
                const dataUrl = await fileToDataUrl(imageFile);
                userMessage.image = dataUrl;
                parts.push({
                    inlineData: {
                        mimeType: imageFile.type,
                        data: dataUrlToBase64(dataUrl)
                    }
                });
            }
            if (text) {
                parts.push({ text });
            }

            setTranscript(prev => [...prev, userMessage]);

            if (!chatSessionRef.current) {
                // Should not happen if initialized, but safety check
                 setTranscript(prev => [...prev, { speaker: 'ai', text: "Error: Session not active." }]);
                 return;
            }

            const response = await chatSessionRef.current.sendMessage({ message: parts });
            
            if (response.functionCalls) {
                for(const fc of response.functionCalls) {
                    if (fc.name === 'submitTriageReport') {
                        handleTriageSubmit(fc.args);
                        return; // Stop processing further
                    }
                }
            }

            const groundingChunks = response.candidates?.[0]?.groundingMetadata?.groundingChunks;
            const groundingLinks = groundingChunks?.map(chunk => chunk.maps && ({ title: chunk.maps.title, uri: chunk.maps.uri })).filter(Boolean);

            setTranscript(prev => [...prev, { speaker: 'ai', text: response.text, grounding: groundingLinks }]);

        } catch (error) {
            console.error("Error sending message:", error);
            setTranscript(prev => [...prev, { speaker: 'ai', text: "I'm sorry, I encountered an error. Could you please repeat that?" }]);
        } finally {
            setIsChatLoading(false);
        }
    };
    
    const handleImageSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
        if (e.target.files && e.target.files[0]) {
            setChatInputImage(e.target.files[0]);
        }
    };
    
    // --- Render Logic ---
    if (isLoading) {
        return <div className="d-flex flex-column justify-content-center align-items-center h-100 text-center">
            <h3>Generating your secure report...</h3>
            <p>This may take a moment.</p>
        </div>;
    }

    const renderTriageChoice = () => (
        <div className="d-flex flex-column justify-content-center align-items-center h-100 text-center p-3">
            <h3>How would you like to proceed?</h3>
            <p className="lead">Describe your symptoms by speaking to our AI assistant or by chatting via text and images.</p>
             {locationError && <p className="text-danger small">{locationError}</p>}
            <div className="d-flex gap-3 mt-3">
                <button className="btn btn-primary btn-lg" onClick={() => setTriageMode('audio')}>Start Audio Triage</button>
                <button className="btn btn-secondary btn-lg" onClick={() => setTriageMode('chat')}>Start Text/Image Triage</button>
            </div>
        </div>
    );

    const renderAudioTriage = () => (
        !isSessionActive ? (
            <div className="d-flex flex-column justify-content-center align-items-center h-100 text-center p-3">
                <h3>Conversational Triage</h3>
                <p>Describe your symptoms by speaking to our AI assistant.</p>
                {locationError && <p className="text-danger small">{locationError}</p>}
                
                {micPermission === 'denied' && (
                    <div className="alert alert-warning my-3">
                        <p className="fw-bold mb-1">Microphone Access Required</p>
                        <p className="mb-0 small">You've denied microphone access or your browser does not support it. Please enable it in your browser's site settings to use audio triage, then click start again.</p>
                    </div>
                )}

                <button 
                    className="btn btn-primary btn-lg" 
                    onClick={handleStartAudioTriage}
                    disabled={micPermission === 'prompting'}
                >
                    {micPermission === 'prompting' ? (
                        <>
                            <span className="spinner-border spinner-border-sm" role="status" aria-hidden="true"></span>
                            <span className="ms-2">Initializing...</span>
                        </>
                    ) : (
                        'Start Audio Triage'
                    )}
                </button>
                <button className="btn btn-link mt-2" onClick={() => setTriageMode('start')}>Back</button>
            </div>
        ) : (
             <div className="d-flex flex-column h-100 p-3">
                <div className="flex-grow-1 w-100 overflow-auto mb-3 d-flex flex-column gap-2">
                     {transcript.map((msg, index) => (
                        <div key={index} className={`w-auto mw-75 p-2 px-3 rounded-3 text-start ${msg.speaker === 'user' ? 'bg-primary text-white align-self-end' : 'bg-light align-self-start'}`}>
                            {msg.text}
                        </div>
                    ))}
                    <div ref={transcriptEndRef} />
                </div>
                <div className="d-flex justify-content-center align-items-center" style={{ minHeight: '80px', margin: '10px 0'}}>
                    <div style={{
                        width: '50px',
                        height: '50px',
                        borderRadius: '50%',
                        backgroundColor: 'var(--bs-primary)',
                        transition: 'transform 0.1s ease-out, opacity 0.1s',
                        transform: `scale(${1 + micVolume * 1.5})`,
                        opacity: Math.max(0.2, micVolume * 2),
                    }}></div>
                </div>
                <div className="p-2 text-center text-muted fst-italic" style={{minHeight: '40px'}}>
                    {statusText}
                </div>
                <button className="btn btn-danger" onClick={audioCleanup}>End Conversation</button>
            </div>
        )
    );

    const renderChatTriage = () => (
         <div className="d-flex flex-column h-100">
            <div className="flex-grow-1 w-100 overflow-auto p-3 d-flex flex-column gap-2">
                {locationError && <p className="text-center text-danger small pb-2">{locationError}</p>}
                {transcript.map((msg, index) => (
                    <div key={index} className={`w-auto mw-75 p-2 px-3 rounded-3 text-start ${msg.speaker === 'user' ? 'bg-primary text-white align-self-end' : 'bg-light align-self-start'}`}>
                        {msg.text}
                        {msg.image && <img src={msg.image} alt="User upload" className="img-fluid rounded mt-1 d-block" style={{maxWidth: '200px'}} />}
                        {msg.grounding && msg.grounding.length > 0 && (
                            <div className="mt-2 p-2 bg-body-tertiary rounded border">
                                <strong className="mb-1 d-block">Relevant places:</strong>
                                <ul className="list-unstyled p-0 m-0">
                                    {msg.grounding.map((link, i) => (
                                        <li key={i} className="mb-1">
                                            <a href={link.uri} target="_blank" rel="noopener noreferrer" className="text-decoration-none fw-medium">
                                                📍 {link.title}
                                            </a>
                                        </li>
                                    ))}
                                </ul>
                            </div>
                        )}
                    </div>
                ))}
                {isChatLoading && (
                    <div className="w-auto mw-75 p-2 px-3 rounded-3 text-start bg-light align-self-start">
                        Typing...
                    </div>
                )}
                 <div ref={transcriptEndRef} />
            </div>
            
             <div className="p-3 border-top bg-white">
                {chatInputImage && (
                    <div className="position-relative mb-2 align-self-start w-auto">
                        <img src={URL.createObjectURL(chatInputImage)} alt="Preview" className="img-thumbnail" style={{maxWidth: '100px', maxHeight: '100px'}}/>
                        <button className="btn btn-sm btn-dark rounded-circle position-absolute top-0 start-100 translate-middle" onClick={() => setChatInputImage(null)} style={{width: '24px', height: '24px', lineHeight: '1', padding: '0'}}>✕</button>
                    </div>
                 )}
                 <div className="d-flex gap-2 align-items-end">
                     <textarea
                         className="form-control"
                         value={chatInputText}
                         onChange={(e) => setChatInputText(e.target.value)}
                         placeholder="Type your message..."
                         rows={1}
                         onKeyDown={(e) => {
                             if (e.key === 'Enter' && !e.shiftKey) {
                                 e.preventDefault();
                                 handleSendMessage();
                             }
                         }}
                     />
                      <label htmlFor="file-upload" className="btn btn-primary flex-shrink-0" style={{fontSize: '1.2em'}} aria-label="Upload image">
                         📎
                     </label>
                     <input id="file-upload" type="file" accept="image/*" className="d-none" onChange={handleImageSelect} />
                     <button className="btn btn-secondary flex-shrink-0" onClick={handleSendMessage} disabled={isChatLoading}>Send</button>
                 </div>
                 <button className="btn btn-link mt-2 w-100" onClick={() => setTriageMode('start')}>Back to Triage Choice</button>
            </div>
         </div>
    );

    return (
        <div className="card shadow-sm h-100">
            <div className="card-header bg-primary text-white d-flex justify-content-between align-items-center">
                <h1 className="h4 m-0">Patient Intake</h1>
                <button className="btn btn-sm btn-light" onClick={onLogout}>Logout</button>
            </div>
            <main className="card-body d-flex flex-column flex-grow-1 overflow-hidden p-0">
                {triageMode === 'start' && renderTriageChoice()}
                {triageMode === 'audio' && renderAudioTriage()}
                {triageMode === 'chat' && renderChatTriage()}
            </main>
        </div>
    );
};


const DoctorView = ({ reports, onLogout }) => {
    const [selectedReportId, setSelectedReportId] = useState(null);
    const [analysis, setAnalysis] = useState({
        isLoading: false,
        data: null,
        error: null,
    });
    const aiRef = useRef<GoogleGenAI | null>(null);

    // This is a mock for which doctor is logged in.
    const loggedInDoctor = "Dr. Smith";

    const assignedReports = reports.filter(r => r.assignedDoctor === loggedInDoctor);

    // Lazy initialize AI to avoid creating it unnecessarily
    const getAi = () => {
        if (!aiRef.current) {
            aiRef.current = new GoogleGenAI({ apiKey: process.env.API_KEY });
        }
        return aiRef.current;
    };

    const handleSelectReport = (reportId: string) => {
        if (selectedReportId === reportId) {
            setSelectedReportId(null); // Deselect if clicking the same report
            setAnalysis({ isLoading: false, data: null, error: null });
        } else {
            setSelectedReportId(reportId);
            setAnalysis({ isLoading: true, data: null, error: null }); // Reset analysis on new selection
            generateAnalysis(reportId);
        }
    };

    const generateAnalysis = async (reportId: string) => {
        const report = reports.find(r => r.Triage_ID === reportId);
        if (!report) {
            setAnalysis({ isLoading: false, data: null, error: 'Report not found.' });
            return;
        }

        try {
            const ai = getAi();
            const prompt = `Analyze the following triage report and provide a concise differential diagnosis and recommended next steps for a medical professional. Format the output as JSON.
            
            Triage Report:
            ${JSON.stringify(report, null, 2)}
            `;

            const responseSchema = {
                type: Type.OBJECT,
                properties: {
                    differential_diagnosis: {
                        type: Type.ARRAY,
                        items: {
                            type: Type.OBJECT,
                            properties: {
                                condition: { type: Type.STRING },
                                probability: { type: Type.STRING, enum: ['High', 'Medium', 'Low'] },
                                rationale: { type: Type.STRING }
                            },
                            required: ['condition', 'probability', 'rationale']
                        }
                    },
                    recommended_next_steps: {
                        type: Type.ARRAY,
                        items: { type: Type.STRING }
                    },
                    urgency_assessment: { type: Type.STRING }
                },
                required: ['differential_diagnosis', 'recommended_next_steps', 'urgency_assessment']
            };

            const response = await ai.models.generateContent({
                model: 'gemini-2.5-pro',
                contents: prompt,
                config: {
                    responseMimeType: 'application/json',
                    responseSchema: responseSchema,
                },
            });

            const analysisData = JSON.parse(response.text);
            setAnalysis({ isLoading: false, data: analysisData, error: null });
        } catch (error) {
            console.error("Error generating analysis:", error);
            setAnalysis({ isLoading: false, data: null, error: 'Failed to generate analysis. Please try again.' });
        }
    };

    const downloadPdf = (report, analysisData) => {
        const doc = new jsPDF();

        doc.setFontSize(18);
        doc.text("Triage Report", 14, 22);

        doc.setFontSize(12);
        doc.text(`Triage ID: ${report.Triage_ID}`, 14, 32);
        doc.text(`Date: ${new Date().toLocaleString()}`, 14, 38);

        let y = 50;

        const addSection = (title, content) => {
            if (y > 260) { doc.addPage(); y = 20; }
            doc.setFontSize(14);
            doc.setFont(undefined, 'bold');
            doc.text(title, 14, y);
            y += 7;
            doc.setFontSize(11);
            doc.setFont(undefined, 'normal');

            const splitContent = doc.splitTextToSize(String(content), 180);
            doc.text(splitContent, 14, y);
            y += (splitContent.length * 5) + 5;
        };

        addSection("Chief Complaint", report.Chief_Complaint_EN);
        addSection("Triage Priority", report.Triage_Priority_Score);
        addSection("Symptoms", report.Structured_Symptom_List.join('\n'));
        addSection("AI Rationale for Priority", report.AI_Rationale);

        if (analysisData) {
            doc.addPage();
            y = 20;
            doc.setFontSize(18);
            doc.text("AI-Powered Analysis", 14, y);
            y += 12;

            addSection("Urgency Assessment", analysisData.urgency_assessment);

            if (y > 260) { doc.addPage(); y = 20; }
            doc.setFontSize(14);
            doc.setFont(undefined, 'bold');
            doc.text("Differential Diagnosis", 14, y);
            y += 7;
            doc.setFontSize(11);
            doc.setFont(undefined, 'normal');
            analysisData.differential_diagnosis.forEach(d => {
                const diagText = `${d.condition} (Probability: ${d.probability}): ${d.rationale}`;
                const splitText = doc.splitTextToSize(diagText, 180);
                if (y + (splitText.length * 5) > 280) {
                    doc.addPage();
                    y = 20;
                }
                doc.text(splitText, 16, y);
                y += (splitText.length * 5) + 2;
            });
            y += 5;

            addSection("Recommended Next Steps", analysisData.recommended_next_steps.join('\n'));
        }

        doc.save(`Triage_Report_${report.Triage_ID}.pdf`);
    };

    const selectedReport = reports.find(r => r.Triage_ID === selectedReportId);

    return (
        <div className="card shadow-sm h-100">
            <div className="card-header bg-secondary text-white d-flex justify-content-between align-items-center">
                <h1 className="h4 m-0">Doctor Dashboard ({loggedInDoctor})</h1>
                <button className="btn btn-sm btn-light" onClick={onLogout}>Logout</button>
            </div>
            <main className="card-body d-flex flex-grow-1 overflow-hidden p-0">
                <div className="col-4 border-end overflow-auto">
                    <div className="list-group list-group-flush">
                        {assignedReports.length === 0 && <div className="p-3 text-muted">No patient reports assigned to you yet.</div>}
                        {assignedReports.map(report => (
                            <button
                                key={report.Triage_ID}
                                onClick={() => handleSelectReport(report.Triage_ID)}
                                className={`list-group-item list-group-item-action ${selectedReportId === report.Triage_ID ? 'active' : ''}`}
                                aria-current={selectedReportId === report.Triage_ID}
                            >
                                <div className="d-flex w-100 justify-content-between">
                                    <h5 className="mb-1">Report: {report.Triage_ID}</h5>
                                    <small>{new Date().toLocaleDateString()}</small>
                                </div>
                                <p className="mb-1 text-truncate">{report.Chief_Complaint_EN}</p>
                                <small>Priority: <span className={`fw-bold ${report.Triage_Priority_Score === 'HIGH' ? 'text-danger' : report.Triage_Priority_Score === 'MEDIUM' ? 'text-warning' : 'text-success'}`}>{report.Triage_Priority_Score}</span></small>
                            </button>
                        ))}
                    </div>
                </div>
                <div className="col-8 d-flex flex-column overflow-auto p-3">
                    {!selectedReport ? (
                        <div className="m-auto text-center text-muted">
                            <h4>Welcome, {loggedInDoctor}.</h4>
                            <p>Select a report from your queue to view details and AI-powered analysis.</p>
                        </div>
                    ) : (
                        <div>
                            <div className="d-flex justify-content-between align-items-center mb-3">
                                <h3>Report: {selectedReport.Triage_ID}</h3>
                                <button
                                    className="btn btn-primary"
                                    onClick={() => downloadPdf(selectedReport, analysis.data)}
                                    disabled={!selectedReport}
                                >
                                    Download PDF
                                </button>
                            </div>

                            <div className="card mb-3">
                                <div className="card-body">
                                    <h5 className="card-title">Triage Summary</h5>
                                    <p><strong>Chief Complaint:</strong> {selectedReport.Chief_Complaint_EN}</p>
                                    <p><strong>Priority:</strong> {selectedReport.Triage_Priority_Score}</p>
                                    <p className="mb-1"><strong>Symptoms:</strong></p>
                                    <ul className="list-group list-group-flush mb-2">
                                        {selectedReport.Structured_Symptom_List.map((symptom, i) => <li className="list-group-item py-1" key={i}>{symptom}</li>)}
                                    </ul>
                                    <p><strong>AI Rationale:</strong> {selectedReport.AI_Rationale}</p>
                                </div>
                            </div>

                            <div className="card">
                                <div className="card-body">
                                    <h5 className="card-title">AI-Powered Analysis</h5>
                                    {analysis.isLoading && (
                                        <div className="d-flex align-items-center">
                                            <strong>Generating analysis...</strong>
                                            <div className="spinner-border ms-auto" role="status" aria-hidden="true"></div>
                                        </div>
                                    )}
                                    {analysis.error && <div className="alert alert-danger">{analysis.error}</div>}
                                    {analysis.data && (
                                        <div>
                                            <h6>Urgency Assessment</h6>
                                            <p>{analysis.data.urgency_assessment}</p>

                                            <h6>Differential Diagnosis</h6>
                                            <ul className="list-group mb-3">
                                                {analysis.data.differential_diagnosis.map((d, i) => (
                                                    <li className="list-group-item" key={i}>
                                                        <strong>{d.condition}</strong> (Probability: {d.probability})
                                                        <p className="mb-0 text-muted small">{d.rationale}</p>
                                                    </li>
                                                ))}
                                            </ul>

                                            <h6>Recommended Next Steps</h6>
                                            <ul className="list-group">
                                                {analysis.data.recommended_next_steps.map((step, i) => <li className="list-group-item" key={i}>{step}</li>)}
                                            </ul>
                                        </div>
                                    )}
                                </div>
                            </div>
                        </div>
                    )}
                </div>
            </main>
        </div>
    );
};

const ClinicView = ({ reports, updateReport, onLogout }) => {
    const doctors = ["Dr. Smith", "Dr. Jones", "Dr. Chen"];
    const statuses = ["Pending Review", "Assigned", "Reviewed", "Completed"];

    const handleDoctorChange = (reportId, newDoctor) => {
        const newStatus = newDoctor ? "Assigned" : "Pending Review";
        updateReport(reportId, { assignedDoctor: newDoctor, status: newStatus });
    };
    
    const handleStatusChange = (reportId, newStatus) => {
        updateReport(reportId, { status: newStatus });
    };

    const getPriorityBadge = (priority) => {
        switch(priority) {
            case 'HIGH': return 'bg-danger';
            case 'MEDIUM': return 'bg-warning text-dark';
            case 'LOW': return 'bg-success';
            default: return 'bg-secondary';
        }
    };

    return (
        <div className="card shadow-sm h-100">
            <div className="card-header bg-info text-white d-flex justify-content-between align-items-center">
                <h1 className="h4 m-0">Clinic Dashboard</h1>
                <button className="btn btn-sm btn-light" onClick={onLogout}>Logout</button>
            </div>
            <main className="card-body d-flex flex-column flex-grow-1 overflow-auto p-3">
                {reports.length === 0 ? (
                    <div className="m-auto text-center text-muted">
                        <h4>No patient reports submitted yet.</h4>
                        <p>Incoming reports will appear here for assignment.</p>
                    </div>
                ) : (
                    <div className="table-responsive">
                        <table className="table table-striped table-hover align-middle">
                            <thead className="table-light">
                                <tr>
                                    <th scope="col">Triage ID</th>
                                    <th scope="col">Chief Complaint</th>
                                    <th scope="col">Priority</th>
                                    <th scope="col">Status</th>
                                    <th scope="col">Assigned Doctor</th>
                                </tr>
                            </thead>
                            <tbody>
                                {reports.map(report => (
                                    <tr key={report.Triage_ID}>
                                        <td>{report.Triage_ID}</td>
                                        <td>{report.Chief_Complaint_EN}</td>
                                        <td>
                                            <span className={`badge ${getPriorityBadge(report.Triage_Priority_Score)}`}>
                                                {report.Triage_Priority_Score}
                                            </span>
                                        </td>
                                        <td>
                                            <select 
                                                className="form-select form-select-sm"
                                                value={report.status}
                                                onChange={(e) => handleStatusChange(report.Triage_ID, e.target.value)}
                                                aria-label={`Status for report ${report.Triage_ID}`}
                                            >
                                                {statuses.map(s => <option key={s} value={s}>{s}</option>)}
                                            </select>
                                        </td>
                                        <td>
                                            <select 
                                                className="form-select form-select-sm"
                                                value={report.assignedDoctor || ''}
                                                onChange={(e) => handleDoctorChange(report.Triage_ID, e.target.value)}
                                                 aria-label={`Assign doctor for report ${report.Triage_ID}`}
                                            >
                                                <option value="">Unassigned</option>
                                                {doctors.map(d => <option key={d} value={d}>{d}</option>)}
                                            </select>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
            </main>
        </div>
    );
};


// --- Main App Component ---
const App = () => {
    const [userType, setUserType] = useState(null); // 'patient', 'doctor', 'clinic' or null
    const [triageReports, setTriageReports] = useState([]);

    const handleLogin = (type) => setUserType(type);
    const handleLogout = () => setUserType(null);

    const handleTriageComplete = (report) => {
        const newReport = {
            ...report,
            status: 'Pending Review',
            assignedDoctor: null,
            date: new Date().toISOString(),
        };
        setTriageReports(prevReports => [...prevReports, newReport]);
        setUserType(null);
        alert(`Triage report ${report.Triage_ID} submitted successfully! A doctor will review it shortly.`);
    };
    
    const handleUpdateReport = (reportId, updates) => {
        setTriageReports(prevReports => 
            prevReports.map(report =>
                report.Triage_ID === reportId ? { ...report, ...updates } : report
            )
        );
    };

    // Add some mock data for demonstration purposes
    useEffect(() => {
        setTriageReports([
            {
                "Triage_ID": "TR-DEMO-001",
                "Patient_Language_Used": "English",
                "Chief_Complaint_EN": "Severe headache and dizziness",
                "Triage_Priority_Score": "HIGH",
                "Structured_Symptom_List": ["Sudden onset of severe headache", "Dizziness and lightheadedness", "Nausea", "Sensitivity to light"],
                "AI_Rationale": "The combination of a sudden, severe headache with neurological symptoms like dizziness suggests a potentially serious condition that requires immediate medical attention.",
                "status": "Assigned",
                "assignedDoctor": "Dr. Smith",
                "date": new Date().toISOString()
            },
            {
                "Triage_ID": "TR-DEMO-002",
                "Patient_Language_Used": "English",
                "Chief_Complaint_EN": "Sore throat and cough",
                "Triage_Priority_Score": "LOW",
                "Structured_Symptom_List": ["Scratchy throat for 2 days", "Dry cough, especially at night", "No fever", "General fatigue"],
                "AI_Rationale": "Symptoms are consistent with a common upper respiratory viral infection. The absence of fever and severe symptoms lowers the priority. Self-care and monitoring are appropriate.",
                "status": "Pending Review",
                "assignedDoctor": null,
                "date": new Date().toISOString()
            },
            {
                "Triage_ID": "TR-DEMO-003",
                "Patient_Language_Used": "English",
                "Chief_Complaint_EN": "Twisted ankle, swelling",
                "Triage_Priority_Score": "MEDIUM",
                "Structured_Symptom_List": ["Fell while running", "Immediate pain in right ankle", "Swelling and bruising", "Difficulty bearing weight"],
                "AI_Rationale": "Symptoms indicate a likely musculoskeletal injury such as a sprain or fracture. While not life-threatening, it requires timely medical evaluation to prevent complications.",
                 "status": "Assigned",
                "assignedDoctor": "Dr. Jones",
                "date": new Date().toISOString()
            }
        ]);
    }, []);

    const renderContent = () => {
        switch (userType) {
            case 'patient':
                return <PatientView onTriageComplete={handleTriageComplete} onLogout={handleLogout} />;
            case 'doctor':
                return <DoctorView reports={triageReports} onLogout={handleLogout} />;
            case 'clinic':
                return <ClinicView reports={triageReports} updateReport={handleUpdateReport} onLogout={handleLogout} />;
            default:
                return <LoginScreen onLogin={handleLogin} />;
        }
    };

    return (
        <div className="vh-100 d-flex flex-column">
            {renderContent()}
        </div>
    );
};
// 3. Define the root App component with routing

const router: React.FC = createBrowserRouter([

    {

        path: "/",

        element: <LandingPage />,

    },

    {

        path: "/app",

        element: <App />,

    }

])





// 4. Render the new router component

const container = document.getElementById('root');

const root = createRoot(container!);



root.render(<RouterProvider router={router}></RouterProvider>);

