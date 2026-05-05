
import os
import sys
import time

INPUT_FILE = "terminal_chat_in.txt"
OUTPUT_FILE = "terminal_chat_out.txt"

def main():
    print("\033[1;32m[DEVSWAT TERMINAL INTERFACE ACTIVE]\033[0m")
    print("Type your message below. I will respond here.")
    
    if os.path.exists(INPUT_FILE): os.remove(INPUT_FILE)
    if os.path.exists(OUTPUT_FILE): os.remove(OUTPUT_FILE)

    while True:
        try:
            user_input = input("\033[1;34mYou > \033[0m")
            if user_input.lower() in ["exit", "quit"]:
                print("Closing bridge...")
                break
            
            # Write input for the AI to read
            with open(INPUT_FILE, "w") as f:
                f.write(user_input)
            
            print("\033[1;33m[DevSwat is thinking...]\033[0m")
            
            # Wait for AI to write response
            while not os.path.exists(OUTPUT_FILE):
                time.sleep(0.5)
            
            with open(OUTPUT_FILE, "r") as f:
                response = f.read()
            
            print(f"\n\033[1;32mDevSwat >\033[0m {response}\n")
            
            # Cleanup for next turn
            os.remove(INPUT_FILE)
            os.remove(OUTPUT_FILE)
            
        except KeyboardInterrupt:
            break

if __name__ == "__main__":
    main()
