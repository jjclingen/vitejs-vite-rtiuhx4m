import { initializeApp } from 'firebase/app';
import { getAuth, GoogleAuthProvider } from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';

const firebaseConfig = {
  apiKey: "AIzaSyDeHyTA4qVrB5JduISaO-L7bUTMuaIxpEU",
  authDomain: "nutriapp-e54d9.firebaseapp.com",
  projectId: "nutriapp-e54d9",
  storageBucket: "nutriapp-e54d9.firebasestorage.app",
  messagingSenderId: "88435713774",
  appId: "1:88435713774:web:3e37c4ea90069ecca7f5ff"
};

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db   = getFirestore(app);
export const googleProvider = new GoogleAuthProvider();
