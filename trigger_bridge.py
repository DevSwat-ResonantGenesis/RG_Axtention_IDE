import os
import time
import sys

INPUT_FILE = "bridge_input.txt"
OUTPUT_FILE = "bridge_output.txt"
SIGNAL_FILE = "bridge_signal.txt"

def main():
    print("\033[1;34m=== DEVSWAT TERMINAL TRIGGER ACTIVE ===\033[0m")
    print("Type a message to trigger me. Type 'exit' to quit.")
    
    if os.path.exists(OUTPUT_FILE):
        os.remove(OUTPUT_FILE)

    try:
        while True:
            user_input = input("\033[1;32mYou > \033[0m")
            if user_input.lower() == 'exit':
                break
            
            # Write input and signal the AI
            with open(INPUT_FILE, "w") as f:
                f.write(user_input)
            
            with open(SIGNAL_FILE, "w") as f:
                f.write("NEW_MESSAGE")
            
            print("\033[1;33m[Waiting for DevSwat...]\033[0m")
            
            # Wait for output
            while not os.path.exists(OUTPUT_FILE):
                time.sleep(0.5)
            
            with open(OUTPUT_FILE, "r") as f:
                response = f.read()
            
            print(f"\r\033[1;36mDevSwat >\033[0m {response}\n")
            os.remove(OUTPUT_FILE)
            
    except KeyboardInterrupt:
        print("\nExiting...")

if __name__ == "__main__":
    main()
