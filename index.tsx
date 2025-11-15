
import React, { useState, useRef, useEffect, useCallback } from 'react';
import { createRoot } from 'react-dom/client';
import { GoogleGenAI, Type, Modality, LiveServerMessage, Blob, FunctionDeclaration, Chat } from '@google/genai';

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

const resampleBuffer = (audioBuffer: AudioBuffer, targetSampleRate: number): Float32Array => {
    const inputData = audioBuffer.getChannelData(0);
    const inputSampleRate = audioBuffer.sampleRate;

    if (inputSampleRate === targetSampleRate) {
        return inputData;
    }

    const ratio = inputSampleRate / targetSampleRate;
    const outputLength = Math.floor(inputData.length / ratio);
    const result = new Float32Array(outputLength);

    for (let i = 0; i < outputLength; i++) {
        const index = i * ratio;
        const before = Math.floor(index);
        const after = Math.min(before + 1, inputData.length - 1);
        const atPoint = index - before;
        result[i] = inputData[before] + (inputData[after] - inputData[before]) * atPoint;
    }

    return result;
};

const fileToDataUrl = (file: File): Promise<string> => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.readAsDataURL(file);
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = error => reject(error);
});

const dataUrlToBase64 = (dataUrl: string) => dataUrl.split(',')[1];


// --- Styles ---
// FIX: Explicitly type the styles object to conform to React.CSSProperties, resolving multiple type errors.
const styles: { [key: string]: React.CSSProperties } = {
    container: {
        width: '100%',
        maxWidth: '800px',
        margin: '0 auto',
        height: 'calc(100vh - 40px)',
        backgroundColor: 'var(--white)',
        borderRadius: 'var(--border-radius)',
        boxShadow: 'var(--box-shadow)',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        marginBlock: '20px',
    },
    header: {
        backgroundColor: 'var(--primary-color)',
        color: 'var(--white)',
        padding: '15px 20px',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
    },
    headerTitle: { margin: 0, fontSize: '1.5em' },
    main: { flex: 1, padding: '20px', overflowY: 'auto', display: 'flex', flexDirection: 'column' },
    loginContainer: {
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        alignItems: 'center',
        height: '100%',
        textAlign: 'center',
    },
    loginButton: { margin: '10px', padding: '15px 30px', fontSize: '1.2em' },
    doctorDashboard: { display: 'flex', height: '100%', gap: '20px' },
    reportList: {
        width: '200px',
        borderRight: '1px solid #eee',
        paddingRight: '20px',
        overflowY: 'auto'
    },
    searchInput: {
        width: '100%',
        padding: '8px',
        marginBottom: '10px',
        borderRadius: 'var(--border-radius)',
        border: '1px solid #ccc',
        boxSizing: 'border-box',
    },
    reportListItem: {
        padding: '10px',
        cursor: 'pointer',
        borderRadius: 'var(--border-radius)',
        marginBottom: '5px',
        border: '1px solid transparent'
    },
    reportDetail: { flex: 1, overflowY: 'auto' },
    pre: {
        backgroundColor: '#f8f9fa',
        padding: '15px',
        borderRadius: 'var(--border-radius)',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        fontFamily: 'monospace'
    },
    loader: { textAlign: 'center', padding: '20px', fontSize: '1.2em', margin: 'auto' },
    // Patient view styles
    conversationContainer: {
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        alignItems: 'center',
        height: '100%',
        textAlign: 'center'
    },
    transcriptContainer: {
        flex: 1,
        width: '100%',
        overflowY: 'auto',
        padding: '15px 15px 0 15px',
        marginBottom: '15px',
    },
    transcriptMessage: {
        marginBottom: '12px',
        padding: '8px 14px',
        borderRadius: '18px',
        maxWidth: '85%',
        display: 'inline-block',
        textAlign: 'left',
        wordBreak: 'break-word',
    },
    userMessage: {
        backgroundColor: 'var(--primary-color)',
        color: 'var(--white)',
        alignSelf: 'flex-end',
        borderBottomRightRadius: '4px',
        float: 'right',
        clear: 'both',
    },
    aiMessage: {
        backgroundColor: '#e9ecef',
        alignSelf: 'flex-start',
        borderBottomLeftRadius: '4px',
        float: 'left',
        clear: 'both',
    },
    statusIndicator: {
        padding: '10px',
        textAlign: 'center',
        color: '#666',
        fontStyle: 'italic',
        minHeight: '40px',
    },
    doctorActions: {
        display: 'flex',
        gap: '10px',
        marginTop: '20px',
        borderTop: '1px solid #eee',
        paddingTop: '20px',
    },
    actionButton: {
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
    },
    chatInputForm: {
        display: 'flex',
        padding: '10px 0',
        borderTop: '1px solid #eee',
        gap: '10px',
        alignItems: 'flex-end',
    },
    chatTextarea: {
        flex: 1,
        resize: 'none',
        padding: '10px',
        borderRadius: 'var(--border-radius)',
        border: '1px solid #ccc',
        fontFamily: 'inherit',
        fontSize: '1em',
        minHeight: '24px',
        maxHeight: '150px',
    },
    chatImagePreview: {
        position: 'relative',
        marginBottom: '10px',
        alignSelf: 'flex-start'
    },
    chatImage: {
        maxWidth: '100px',
        maxHeight: '100px',
        borderRadius: 'var(--border-radius)',
        border: '1px solid #eee',
    },
    removeImageButton: {
        position: 'absolute',
        top: '-10px',
        right: '-10px',
        background: 'rgba(0,0,0,0.6)',
        color: 'white',
        border: 'none',
        borderRadius: '50%',
        width: '24px',
        height: '24px',
        cursor: 'pointer',
        lineHeight: '24px',
        textAlign: 'center',
        padding: 0,
        fontSize: '14px',
    },
    chatTranscriptImage: {
        maxWidth: '200px',
        borderRadius: 'var(--border-radius)',
        marginTop: '5px',
        display: 'block'
    },
    triageChoiceContainer: {
        display: 'flex',
        gap: '20px',
    },
    groundingContainer: {
        marginTop: '10px',
        padding: '10px',
        backgroundColor: '#f8f9fa',
        borderRadius: 'var(--border-radius)',
        border: '1px solid #dee2e6',
    },
    groundingList: {
        listStyle: 'none',
        padding: 0,
        margin: 0,
    },
    groundingListItem: {
        marginBottom: '5px',
    },
    groundingLink: {
        textDecoration: 'none',
        color: 'var(--primary-color)',
        fontWeight: '500',
    },
};

// --- Components ---

const LoginScreen = ({ onLogin }) => (
    <div style={styles.container}>
        <div style={styles.header}>
            <h1 style={styles.headerTitle}>Doc Rush</h1>
        </div>
        <main style={{...styles.main, ...styles.loginContainer}}>
            <h2>Welcome to Doc Rush</h2>
            <p>Your AI-powered medical triage assistant.</p>
            <div>
                <button style={styles.loginButton} className="primary-button" onClick={() => onLogin('patient')}>I'm a Patient</button>
                <button style={styles.loginButton} className="secondary-button" onClick={() => onLogin('doctor')}>I'm a Doctor</button>
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
        transcriptEndRef.current?.scrollIntoView({ behavior: "smooth" });
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


    // Common triage function declaration
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

    const handleTriageSubmit = (args: any) => {
        setIsLoading(true);
        setStatusText('Triage complete. Generating report...');
        if (triageMode === 'audio') audioCleanup();
        onTriageComplete(args);
    };

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
        setStatusText('Session ended. Click below to start a new triage conversation.');
    }, []);

    useEffect(() => {
        return () => { if (isSessionActive) audioCleanup() };
    }, [isSessionActive, audioCleanup]);

    const handleStartAudioTriage = async () => {
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
                    onopen: async () => {
                        setStatusText('Microphone active. Please start speaking.');
                        inputAudioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
                        streamRef.current = await navigator.mediaDevices.getUserMedia({ audio: true });
                        mediaStreamSourceRef.current = inputAudioContextRef.current.createMediaStreamSource(streamRef.current);
                        scriptProcessorRef.current = inputAudioContextRef.current.createScriptProcessor(4096, 1, 1);
                        
                        scriptProcessorRef.current.onaudioprocess = (audioProcessingEvent) => {
                            const resampledData = resampleBuffer(audioProcessingEvent.inputBuffer, 16000);
                            const pcmBlob: Blob = {
                                data: encode(new Uint8Array(new Int16Array(resampledData.map(x => x * 32768)).buffer)),
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
                        const base64Audio = message.serverContent?.modelTurn?.parts[0]?.inlineData.data;
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
            alert("Could not start the triage session. Please ensure microphone permissions are granted and try again.");
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
    }, [submitTriageReportFunctionDeclaration, userLocation]);

    useEffect(() => {
        if (triageMode === 'chat' && !chatSessionRef.current) {
            initializeChat();
        }
    }, [triageMode, initializeChat]);

    const handleSendMessage = async () => {
        const text = chatInputText.trim();
        const imageFile = chatInputImage;

        if (!text && !imageFile) return;

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

            // FIX: The `message` property for `sendMessage` should be an array of parts, not an object containing a `parts` property.
            const response = await chatSessionRef.current!.sendMessage({ message: parts });
            
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
        return <div style={{...styles.container, ...styles.loginContainer, ...styles.loader}}>
            <h3>Generating your secure report...</h3>
            <p>This may take a moment.</p>
        </div>;
    }

    const renderTriageChoice = () => (
        <div style={styles.conversationContainer}>
            <h3>How would you like to proceed?</h3>
            <p>Describe your symptoms by speaking to our AI assistant or by chatting via text and images.</p>
             {locationError && <p style={{color: 'red', fontSize: '0.9em'}}>{locationError}</p>}
            <div style={styles.triageChoiceContainer}>
                <button className="primary-button" style={{padding: '15px 30px', fontSize: '1.2em'}} onClick={() => setTriageMode('audio')}>Start Audio Triage</button>
                <button className="secondary-button" style={{padding: '15px 30px', fontSize: '1.2em'}} onClick={() => setTriageMode('chat')}>Start Text/Image Triage</button>
            </div>
        </div>
    );

    const renderAudioTriage = () => (
        !isSessionActive ? (
            <div style={styles.conversationContainer}>
                <h3>Conversational Triage</h3>
                <p>Describe your symptoms by speaking to our AI assistant.</p>
                {locationError && <p style={{color: 'red', fontSize: '0.9em'}}>{locationError}</p>}
                <button className="primary-button" style={{padding: '15px 30px', fontSize: '1.2em'}} onClick={handleStartAudioTriage}>Start Audio Triage</button>
                <button style={{marginTop: '10px'}} onClick={() => setTriageMode('start')}>Back</button>
            </div>
        ) : (
            <>
                <div style={styles.transcriptContainer}>
                     {transcript.map((msg, index) => (
                        <div key={index} style={{...styles.transcriptMessage, ...(msg.speaker === 'user' ? styles.userMessage : styles.aiMessage)}}>
                            {msg.text}
                        </div>
                    ))}
                    <div ref={transcriptEndRef} />
                </div>
                <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '80px', margin: '10px 0'}}>
                    <div style={{
                        width: '50px',
                        height: '50px',
                        borderRadius: '50%',
                        backgroundColor: 'var(--primary-color)',
                        transition: 'transform 0.1s ease-out, opacity 0.1s',
                        transform: `scale(${1 + micVolume * 1.2})`,
                        opacity: Math.max(0.2, micVolume * 2),
                    }}></div>
                </div>
                <div style={styles.statusIndicator}>
                    {statusText}
                </div>
                <button className="secondary-button" onClick={audioCleanup}>End Conversation</button>
            </>
        )
    );

    const renderChatTriage = () => (
         <>
            <div style={styles.transcriptContainer}>
                {locationError && <p style={{textAlign: 'center', color: 'red', fontSize: '0.9em', paddingBottom: '10px'}}>{locationError}</p>}
                {transcript.map((msg, index) => (
                    <div key={index} style={{...styles.transcriptMessage, ...(msg.speaker === 'user' ? styles.userMessage : styles.aiMessage)}}>
                        {msg.text}
                        {msg.image && <img src={msg.image} alt="User upload" style={styles.chatTranscriptImage} />}
                        {msg.grounding && msg.grounding.length > 0 && (
                            <div style={styles.groundingContainer}>
                                <strong style={{marginBottom: '5px', display: 'block'}}>Relevant places:</strong>
                                <ul style={styles.groundingList}>
                                    {msg.grounding.map((link, i) => (
                                        <li key={i} style={styles.groundingListItem}>
                                            <a href={link.uri} target="_blank" rel="noopener noreferrer" style={styles.groundingLink}>
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
                    <div style={{...styles.transcriptMessage, ...styles.aiMessage}}>
                        Typing...
                    </div>
                )}
                 <div ref={transcriptEndRef} />
            </div>
            
             <div style={{padding: '0 15px'}}>
                {chatInputImage && (
                    <div style={styles.chatImagePreview}>
                        <img src={URL.createObjectURL(chatInputImage)} alt="Preview" style={styles.chatImage} />
                        <button style={styles.removeImageButton} onClick={() => setChatInputImage(null)}>✕</button>
                    </div>
                 )}
                 <div style={styles.chatInputForm}>
                     <textarea
                         style={styles.chatTextarea}
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
                      <label htmlFor="file-upload" className="primary-button" style={{padding: '10px', cursor: 'pointer', fontSize: '1.5em'}} aria-label="Upload image">
                         📎
                     </label>
                     <input id="file-upload" type="file" accept="image/*" style={{display: 'none'}} onChange={handleImageSelect} />
                     <button className="secondary-button" onClick={handleSendMessage} disabled={isChatLoading}>Send</button>
                 </div>
                 <button style={{marginTop: '10px', width: '100%'}} onClick={() => setTriageMode('start')}>Back to Triage Choice</button>
            </div>
         </>
    );

    return (
        <div style={styles.container}>
            <div style={styles.header}>
                <h1 style={styles.headerTitle}>Patient Intake</h1>
                <button onClick={onLogout}>Logout</button>
            </div>
            <main style={styles.main}>
                {triageMode === 'start' && renderTriageChoice()}
                {triageMode === 'audio' && renderAudioTriage()}
                {triageMode === 'chat' && renderChatTriage()}
            </main>
        </div>
    );
};


const DoctorView = ({ reports, onLogout }) => {
    const [selectedReportId, setSelectedReportId] = useState(null);
    const [analysis, setAnalysis] = useState({ id: null, content: '', isLoading: false });
    const [isSpeaking, setIsSpeaking] = useState(false);
    const [searchQuery, setSearchQuery] = useState('');


    useEffect(() => {
        if (reports.length > 0 && !selectedReportId) {
            setSelectedReportId(reports[0].Triage_ID);
        }
    }, [reports, selectedReportId]);
    
    useEffect(() => {
        // Reset analysis when selected report changes
        setAnalysis({ id: null, content: '', isLoading: false });
    }, [selectedReportId]);

    const selectedReport = reports.find(r => r.Triage_ID === selectedReportId);

    const filteredReports = reports.filter(report => 
        report.Triage_ID.toLowerCase().includes(searchQuery.toLowerCase()) ||
        report.Chief_Complaint_EN.toLowerCase().includes(searchQuery.toLowerCase())
    );

    const getPriorityStyle = (priority) => {
        switch (priority) {
            case 'HIGH': return { color: '#dc3545', fontWeight: 'bold' };
            case 'MEDIUM': return { color: '#ffc107', fontWeight: 'bold' };
            case 'LOW': return { color: '#28a745', fontWeight: 'bold' };
            default: return {};
        }
    };

    const handleDeepAnalysis = async (report) => {
        setAnalysis({ id: report.Triage_ID, content: '', isLoading: true });
        try {
            const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
            const prompt = `Based on the following triage report, provide a deeper analysis for a medical professional. Include potential differential diagnoses, suggest immediate next steps or tests, and briefly mention any relevant research or similar case studies. Keep the language clinical and concise.
            
            Triage Report:
            ${JSON.stringify(report, null, 2)}`;

            const response = await ai.models.generateContent({
                model: 'gemini-2.5-pro',
                contents: prompt,
                config: {
                    thinkingConfig: { thinkingBudget: 32768 }
                }
            });

            setAnalysis({ id: report.Triage_ID, content: response.text, isLoading: false });

        } catch (error) {
            console.error("Error getting deep analysis:", error);
            setAnalysis({ id: report.Triage_ID, content: 'Error generating analysis.', isLoading: false });
        }
    };
    
    const handleReadReport = async (report) => {
        if (isSpeaking) return;
        setIsSpeaking(true);
        try {
            const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
            const textToRead = `Triage Report Summary for patient ${report.Triage_ID}. Priority is ${report.Triage_Priority_Score}. Chief Complaint: ${report.Chief_Complaint_EN}.`;
            const response = await ai.models.generateContent({
                model: "gemini-2.5-flash-preview-tts",
                contents: [{ parts: [{ text: textToRead }] }],
                config: {
                    responseModalities: [Modality.AUDIO],
                    speechConfig: {
                        voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } },
                    },
                },
            });
            const base64Audio = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
            if (base64Audio) {
                 // FIX: Cast window to `any` to access the vendor-prefixed `webkitAudioContext`.
                 const outputAudioContext = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
                 const audioBuffer = await decodeAudioData(decode(base64Audio), outputAudioContext, 24000, 1);
                 const source = outputAudioContext.createBufferSource();
                 source.buffer = audioBuffer;
                 source.connect(outputAudioContext.destination);
                 source.start();
                 source.onended = () => {
                     outputAudioContext.close();
                     setIsSpeaking(false);
                 };
            } else {
                setIsSpeaking(false);
            }
        } catch (error) {
            console.error("Error generating speech:", error);
            setIsSpeaking(false);
        }
    };
    
    return (
        <div style={styles.container}>
            <div style={styles.header}>
                <h1 style={styles.headerTitle}>Doctor Dashboard</h1>
                <button onClick={onLogout}>Logout</button>
            </div>
            <main style={{...styles.main, ...styles.doctorDashboard}}>
                <div style={styles.reportList}>
                    <h3 style={{marginTop: 0}}>Triage Queue</h3>
                    {reports.length === 0 ? (
                        <p>No reports yet.</p> 
                    ) : (
                        <>
                            <input
                                type="text"
                                placeholder="Search by ID or complaint..."
                                value={searchQuery}
                                onChange={(e) => setSearchQuery(e.target.value)}
                                style={styles.searchInput}
                            />
                            {filteredReports.length === 0 ? <p>No matching reports.</p> : filteredReports.map(report => (
                                <div 
                                    key={report.Triage_ID}
                                    style={{...styles.reportListItem, backgroundColor: selectedReportId === report.Triage_ID ? '#e9ecef' : 'transparent', borderColor: selectedReportId === report.Triage_ID ? '#007bff' : 'transparent'}}
                                    onClick={() => setSelectedReportId(report.Triage_ID)}
                                >
                                    {report.Triage_ID}
                                </div>
                            ))}
                        </>
                    )}
                </div>
                <div style={styles.reportDetail}>
                    {selectedReport ? (
                        <>
                             <h2 style={{marginTop: 0}}>Report: {selectedReport.Triage_ID}</h2>
                             <p><strong>Priority:</strong> <span style={getPriorityStyle(selectedReport.Triage_Priority_Score)}>{selectedReport.Triage_Priority_Score}</span></p>
                             <p><strong>Patient Language:</strong> {selectedReport.Patient_Language_Used}</p>
                             <p><strong>Chief Complaint:</strong> {selectedReport.Chief_Complaint_EN}</p>
                             <div>
                                <strong>Symptoms:</strong>
                                <ul>
                                    {selectedReport.Structured_Symptom_List.map((symptom, i) => <li key={i}>{symptom}</li>)}
                                </ul>
                             </div>
                             <p><strong>AI Rationale:</strong> {selectedReport.AI_Rationale}</p>

                             <div style={styles.doctorActions}>
                                <button className="secondary-button" style={styles.actionButton} onClick={() => handleDeepAnalysis(selectedReport)} disabled={analysis.isLoading}>
                                    {analysis.isLoading && analysis.id === selectedReportId ? 'Analyzing...' : '🧠 Deeper Analysis'}
                                </button>
                                 <button className="primary-button" style={styles.actionButton} onClick={() => handleReadReport(selectedReport)} disabled={isSpeaking}>
                                    {isSpeaking ? 'Speaking...' : '🔊 Read Aloud'}
                                </button>
                             </div>

                             {analysis.id === selectedReportId && (
                                <div style={{marginTop: '20px'}}>
                                    {analysis.isLoading ? (
                                        <div style={styles.loader}>Getting deeper insights...</div>
                                    ) : (
                                        analysis.content && (
                                            <div>
                                                <h3>Deep Analysis</h3>
                                                <pre style={styles.pre}>{analysis.content}</pre>
                                            </div>
                                        )
                                    )}
                                </div>
                             )}
                        </>
                    ) : <p>Select a report to view details.</p>}
                </div>
            </main>
        </div>
    );
};

const App = () => {
    const [userRole, setUserRole] = useState(null); // 'patient', 'doctor', or null
    const [reports, setReports] = useState([]);

    const handleLogin = (role) => setUserRole(role);
    const handleLogout = () => {
        setUserRole(null);
        // Optional: clear reports on logout if desired
        // setReports([]); 
    };

    const handleTriageComplete = (report) => {
        setReports(prev => [...prev, report]);
        alert(`Triage complete! Your ID is ${report.Triage_ID}. Please provide this to the clinic.`);
        setUserRole('doctor'); // Switch to doctor view to show the new report
    };

    if (!userRole) {
        return <LoginScreen onLogin={handleLogin} />;
    }

    if (userRole === 'patient') {
        return <PatientView onTriageComplete={handleTriageComplete} onLogout={handleLogout} />;
    }

    if (userRole === 'doctor') {
        return <DoctorView reports={reports} onLogout={handleLogout} />;
    }

    return null;
};

const root = createRoot(document.getElementById('root'));
root.render(<App />);
