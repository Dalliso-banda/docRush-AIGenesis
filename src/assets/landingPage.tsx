
import React from 'react';
import '../assets/css/landingPage.css';
import { Link } from 'react-router-dom';

const LandingPage: React.FC = () => {
    // You may need to ensure your CSS is loaded for this component
    return (
        <div className="wrapping-container p-5">
        <div className="container-landing" >
            <h1>DOCRUSH</h1>
            <h2>AI-Powered Patient Engagement</h2>
            <p>The Future of Healthcare, Simplified.</p>

          
            <Link to="/app" className="cta-button">
               start demo now
            </Link>
        </div>
        </div>
    );
};

export default LandingPage;