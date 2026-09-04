import { BrowserRouter, Routes, Route, useLocation } from "react-router-dom";

import Home from "./pages/Home";
import About from "./pages/About";
import Author from "./pages/Author";
import GlobalSearch from "./pages/GlobalSearch";
import Settings from "./pages/Settings";
import DatasetGenerator from "./pages/DatasetGenerator";
import Granthas from "./pages/Granthas";
import GranthaSourceViewer from "./pages/GranthaSourceViewer";
import AiAgent from "./pages/AiAgent";
import ScrollNavigator from "./components/ScrollNavigator";
import LiveRagLogs from "./components/ai/LiveRagLogs";

function AppShell() {
    const location = useLocation();

    return (
        <>
            <ScrollNavigator pathname={location.pathname} />
            {location.pathname === '/agent' && <LiveRagLogs />}

            <Routes>
                <Route path="/" element={<Home />} />
                <Route path="/about" element={<About />} />
                <Route path="/global-search" element={<GlobalSearch />} />
                <Route path="/settings" element={<Settings />} />
                <Route path="/dataset" element={<DatasetGenerator />} />
                <Route path="/granthas" element={<Granthas />} />
                <Route path="/granthas/source" element={<GranthaSourceViewer />} />
                <Route path="/author/:id" element={<Author />} />
                <Route path="/agent" element={<AiAgent />} />
            </Routes>
        </>
    );
}

function App() {
    return (
        <BrowserRouter>
            <AppShell />
        </BrowserRouter>
    );
}

export default App;
