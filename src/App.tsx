import { BrowserRouter, Routes, Route } from "react-router-dom";

import Home from "./pages/Home";
import About from "./pages/About";
import Author from "./pages/Author";
import GlobalSearch from "./pages/GlobalSearch";
import Settings from "./pages/Settings";
import DatasetGenerator from "./pages/DatasetGenerator";
import AiAgent from "./pages/AiAgent";
import ScrollNavigator from "./components/ScrollNavigator";



function App() {

    return (

        <BrowserRouter>

            <ScrollNavigator />

            <Routes>

                <Route
                    path="/"
                    element={<Home />}
                />

                <Route
                    path="/about"
                    element={<About />}
                />

                <Route
                    path="/global-search"
                    element={<GlobalSearch />}
                />

                <Route
                    path="/settings"
                    element={<Settings />}
                />

                <Route
                    path="/dataset"
                    element={<DatasetGenerator />}
                />

                <Route
                    path="/author/:id"
                    element={<Author />}
                />

                <Route
                    path="/agent"
                    element={<AiAgent />}
                />





            </Routes>

        </BrowserRouter>

    );

}

export default App;
