import React, { useState, useRef, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { GoogleGenAI, Type } from '@google/genai';

// --- Helper Functions ---
const fileToGenerativePart = async (file) => {
    // FIX: Add <string> to Promise to fix 'unknown' data type, and cast reader.result to string to use '.split()'.
    // This resolves the error on line 9 and helps fix errors on lines 201 and 205.
    const base64EncodedDataPromise = new Promise<string>((resolve) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve((reader.result as string).split(',')[1]);
        reader.readAsDataURL(file);
    });
    return {
        inlineData: { data: await base64EncodedDataPromise, mimeType: file.type },
    };
};

// --- Styles ---
const styles = {
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
    main: { flex: 1, padding: '20px', overflowY: 'auto' },
    loginContainer: {
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        alignItems: 'center',
        height: '100%',
        textAlign: 'center',
    },
    loginButton: { margin: '10px', padding: '15px 30px', fontSize: '1.2em' },
    chatContainer: {
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
    },
    chatMessages: {
        flex: 1,
        overflowY: 'auto',
        padding: '10px',
        border: '1px solid #eee',
        borderRadius: 'var(--border-radius)',
        marginBottom: '15px'
    },
    chatMessage: {
        marginBottom: '10px',
        padding: '8px 12px',
        borderRadius: '15px',
        maxWidth: '80%',
    },
    aiMessage: { backgroundColor: '#e9ecef', alignSelf: 'flex-start', borderBottomLeftRadius: '0px' },
    userInputArea: { display: 'flex', gap: '10px', alignItems: 'center' },
    textInput: {
        flex: 1,
        padding: '10px',
        borderRadius: 'var(--border-radius)',
        border: '1px solid #ccc',
        fontSize: '1em'
    },
    iconButton: {
        padding: '10px',
        backgroundColor: '#f0f0f0',
        borderRadius: '50%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center'
    },
    doctorDashboard: { display: 'flex', height: '100%', gap: '20px' },
    reportList: {
        width: '200px',
        borderRight: '1px solid #eee',
        paddingRight: '20px',
        overflowY: 'auto'
    },
    reportListItem: {
        padding: '10px',
        cursor: 'pointer',
        borderRadius: 'var(--border-radius)',
        marginBottom: '5px',
        border: '1px solid transparent'
    },
    reportDetail: { flex: 1 },
    pre: {
        backgroundColor: '#f8f9fa',
        padding: '15px',
        borderRadius: 'var(--border-radius)',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        fontFamily: 'monospace'
    },
    loader: { textAlign: 'center', padding: '20px', fontSize: '1.2em' },
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
    const [isLoading, setIsLoading] = useState(false);
    const [symptoms, setSymptoms] = useState('');
    const [imageFile, setImageFile] = useState(null);
    const [audioBlob, setAudioBlob] = useState(null);
    const [isRecording, setIsRecording] = useState(false);
    const mediaRecorderRef = useRef(null);
    const imageInputRef = useRef(null);

    const handleStartRecording = async () => {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            mediaRecorderRef.current = new MediaRecorder(stream);
            const audioChunks = [];
            mediaRecorderRef.current.ondataavailable = event => audioChunks.push(event.data);
            mediaRecorderRef.current.onstop = () => {
                const audioBlob = new Blob(audioChunks, { type: 'audio/webm' });
                setAudioBlob(audioBlob);
            };
            mediaRecorderRef.current.start();
            setIsRecording(true);
        } catch (err) {
            console.error("Error accessing microphone:", err);
            alert("Could not access microphone. Please ensure permissions are granted.");
        }
    };

    const handleStopRecording = () => {
        mediaRecorderRef.current.stop();
        setIsRecording(false);
    };

    const handleSubmit = async () => {
        if (!symptoms.trim()) {
            alert('Please describe your symptoms.');
            return;
        }
        setIsLoading(true);

        try {
            const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
            
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

            const systemInstruction = `You are Doc Rush, an AI medical triage agent.
            The user will provide their symptoms in their native language, potentially with an image and an audio recording.
            Your tasks are:
            1. Analyze all inputs (text, image, audio) to understand the patient's condition.
            2. Generate a unique Triage_ID (e.g., DR-XXXXXX).
            3. Identify the language the patient used.
            4. Summarize the chief complaint in clinical English.
            5. Assign a priority score (HIGH, MEDIUM, LOW) based on urgency.
            6. Create a structured list of key symptoms in English.
            7. Provide a concise rationale for your assessment, mentioning all inputs (e.g., "Priority HIGH due to visual evidence of swelling in the image and reported shortness of breath in the audio.").
            8. You MUST return the output as a single, valid JSON object that conforms to the provided schema. Do not add any extra text or markdown formatting.`;

            // FIX: Explicitly type the 'parts' array to hold a union of text and inlineData parts,
            // resolving assignment errors on lines 201 and 205.
            const parts: ({ text: string } | { inlineData: { data: string; mimeType: string; } })[] = [{ text: `Patient's written symptoms: ${symptoms}` }];
            if (imageFile) {
                const imagePart = await fileToGenerativePart(imageFile);
                parts.push(imagePart);
            }
            if (audioBlob) {
                const audioPart = await fileToGenerativePart(audioBlob);
                parts.push(audioPart);
            }

            const response = await ai.models.generateContent({
                model: 'gemini-2.5-flash',
                contents: { parts },
                config: {
                    systemInstruction,
                    responseMimeType: 'application/json',
                    responseSchema: triageSchema,
                },
            });
            
            const report = JSON.parse(response.text);
            onTriageComplete(report);

        } catch (error) {
            console.error("Error generating triage report:", error);
            alert("Sorry, there was an error processing your request. Please try again.");
        } finally {
            setIsLoading(false);
        }
    };

    if (isLoading) {
        return <div style={{...styles.container, ...styles.loginContainer, ...styles.loader}}>
            <h3>Analyzing your symptoms...</h3>
            <p>The AI is generating a secure report for your doctor. This may take a moment.</p>
        </div>;
    }

    return (
        <div style={styles.container}>
            <div style={styles.header}>
                <h1 style={styles.headerTitle}>Patient Intake</h1>
                <button onClick={onLogout}>Logout</button>
            </div>
            <main style={styles.main}>
                <h3>Describe Your Symptoms</h3>
                <p>Please provide as much detail as possible. You can write, upload a photo, and record a voice message.</p>
                <textarea
                    style={{...styles.textInput, width: '95%', minHeight: '100px', marginBottom: '15px'}}
                    placeholder="E.g., I have a sharp pain in my stomach and a red rash on my arm..."
                    value={symptoms}
                    onChange={(e) => setSymptoms(e.target.value)}
                />
                <div style={{...styles.userInputArea, justifyContent: 'space-between'}}>
                    <div style={{display: 'flex', gap: '10px'}}>
                        <button style={styles.iconButton} onClick={() => imageInputRef.current.click()}>
                            📎 Attach Photo
                        </button>
                        <input type="file" accept="image/*" ref={imageInputRef} style={{display: 'none'}} onChange={e => setImageFile(e.target.files[0])} />
                        
                        <button style={styles.iconButton} onClick={isRecording ? handleStopRecording : handleStartRecording}>
                            {isRecording ? '🛑 Stop Recording' : '🎤 Record Audio'}
                        </button>
                    </div>
                    <button className="primary-button" onClick={handleSubmit}>Submit to Doctor</button>
                </div>
                 {imageFile && <p style={{marginTop: '10px'}}>✔️ Image attached: {imageFile.name}</p>}
                 {audioBlob && <p style={{marginTop: '10px'}}>✔️ Audio recorded.</p>}
                 {isRecording && <p style={{marginTop: '10px', color: 'red'}}>🔴 Recording in progress...</p>}
            </main>
        </div>
    );
};

const DoctorView = ({ reports, onLogout }) => {
    const [selectedReportId, setSelectedReportId] = useState(null);

    useEffect(() => {
        if (reports.length > 0 && !selectedReportId) {
            setSelectedReportId(reports[0].Triage_ID);
        }
    }, [reports, selectedReportId]);

    const selectedReport = reports.find(r => r.Triage_ID === selectedReportId);

    const getPriorityStyle = (priority) => {
        switch (priority) {
            case 'HIGH': return { color: '#dc3545', fontWeight: 'bold' };
            case 'MEDIUM': return { color: '#ffc107', fontWeight: 'bold' };
            case 'LOW': return { color: '#28a745', fontWeight: 'bold' };
            default: return {};
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
                    {reports.length === 0 ? <p>No reports yet.</p> : reports.map(report => (
                        <div 
                            key={report.Triage_ID}
                            style={{...styles.reportListItem, backgroundColor: selectedReportId === report.Triage_ID ? '#e9ecef' : 'transparent', borderColor: selectedReportId === report.Triage_ID ? '#007bff' : 'transparent'}}
                            onClick={() => setSelectedReportId(report.Triage_ID)}
                        >
                            {report.Triage_ID}
                        </div>
                    ))}
                </div>
                <div style={styles.reportDetail}>
                    {selectedReport ? (
                        <div>
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
                        </div>
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
    const handleLogout = () => setUserRole(null);

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
