import os
import time
import sys

INPUT_FILE = "bridge_input.txt"
OUTPUT_FILE = "bridge_output.txt"
SIGNAL_FILE = "bridge_signal.txt"

def main():
    print("\033[1;34m=== DEVSWAT INTERACTIVE TERMINAL ===\033[0m")
    print("I am now listening. Type your message below.")
    
    # Clear old files
    for f in [INPUT_FILE, OUTPUT_FILE, SIGNAL_FILE]:
        if os.path.exists(f): os.remove(f)

    try:
        while True:
            user_input = input("\033[1;32mYou > \033[0m")
            if user_input.lower() in ['exit', 'quit']:
                break
            
            # Write input and signal the AI
            with open(INPUT_FILE, "w") as f:
                f.write(user_input)
            with open(SIGNAL_FILE, "w") as f:
                f.write("1")
            
            print("\033[1;33m[DevSwat is thinking...]\033[0m")
            
            # Wait for AI to write response and clear signal
            while os.path.exists(SIGNAL_FILE):
                time.sleep(0.5)
            
            if os.path.exists(OUTPUT_FILE):
                with open(OUTPUT_FILE, "r") as f:
                    response = f.read()
                print(f"\n\033[1;36m[DevSwat]:\033[0m {response}\n")
                os.remove(OUTPUT_FILE)
            else:
                print("\n\033[1;31m[Error]: No response received.\033[0m\n")

    except KeyboardInterrupt:
        print("\nExiting...")

if __name__ == "__main__":
    main()
